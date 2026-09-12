import { randomUUID } from 'node:crypto';
import { and, eq, isNull, lte, or } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema, withDrizzleTenantContext } from '@jetnine/db';
import * as webpush from 'web-push';
const jobs = schema.chatPushDeliveries;
const subscriptions = schema.chatPushSubscriptions;
export type PushSender = (
  subscription: webpush.PushSubscription,
  payload: string,
) => Promise<unknown>;
export class ChatPushWorker {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly send: PushSender,
    private readonly environment: string,
    private readonly now = () => new Date(),
  ) {}
  async runOnce(businessId: string) {
    const claimed = await withDrizzleTenantContext(this.db, { businessId }, async (tx) => {
      const [entry] = await tx
        .select({ job: jobs })
        .from(jobs)
        .innerJoin(
          subscriptions,
          and(
            eq(subscriptions.id, jobs.subscriptionId),
            eq(subscriptions.businessId, businessId),
            eq(subscriptions.environment, this.environment),
          ),
        )
        .where(
          and(
            eq(jobs.businessId, businessId),
            isNull(jobs.completedAt),
            isNull(jobs.failedAt),
            lte(jobs.availableAt, this.now()),
            or(isNull(jobs.leaseExpiresAt), lte(jobs.leaseExpiresAt, this.now())),
          ),
        )
        .orderBy(jobs.availableAt)
        .limit(1)
        .for('update', { of: jobs, skipLocked: true });
      const job = entry?.job;
      if (!job) return null;
      const [subscription] = await tx
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.businessId, businessId),
            eq(subscriptions.id, job.subscriptionId),
            eq(subscriptions.environment, this.environment),
          ),
        );
      if (!subscription) return null;
      const [member] = await tx
        .select()
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.businessId, businessId),
            eq(schema.memberships.id, subscription.membershipId),
            eq(schema.memberships.userId, subscription.userId),
            eq(schema.memberships.status, 'active'),
            eq(schema.memberships.dataScope, 'all'),
          ),
        );
      let authorized = false;
      if (member) {
        const roles = await tx
          .select()
          .from(schema.rolePermissions)
          .where(
            and(
              eq(schema.rolePermissions.roleId, member.roleId),
              eq(schema.rolePermissions.permission, 'chat.view_team'),
            ),
          );
        const overrides = await tx
          .select()
          .from(schema.membershipPermissionOverrides)
          .where(
            and(
              eq(schema.membershipPermissionOverrides.businessId, businessId),
              eq(schema.membershipPermissionOverrides.membershipId, member.id),
              eq(schema.membershipPermissionOverrides.permission, 'chat.view_team'),
            ),
          );
        authorized = overrides[0]?.allowed ?? roles.length > 0;
      }
      if (!authorized) {
        await tx.delete(subscriptions).where(eq(subscriptions.id, subscription.id));
        return { skipped: true } as const;
      }
      const [conversation] = await tx
        .select()
        .from(schema.chatConversations)
        .where(
          and(
            eq(schema.chatConversations.businessId, businessId),
            eq(schema.chatConversations.id, job.conversationId),
          ),
        );
      const [source] = conversation
        ? await tx
            .select({
              enabled: schema.chatIntegrations.enabled,
              revokedAt: schema.chatSessions.revokedAt,
              environment: schema.chatIntegrations.environment,
            })
            .from(schema.chatSessions)
            .innerJoin(
              schema.chatIntegrations,
              and(
                eq(schema.chatIntegrations.id, schema.chatSessions.integrationId),
                eq(schema.chatIntegrations.businessId, businessId),
              ),
            )
            .where(
              and(
                eq(schema.chatSessions.id, conversation.sessionId),
                eq(schema.chatSessions.businessId, businessId),
              ),
            )
        : [];
      if (
        !source?.enabled ||
        source.revokedAt ||
        source.environment !== this.environment ||
        !conversation ||
        conversation.staffReadSequence >= job.sequence ||
        ['resolved', 'spam'].includes(conversation.status)
      ) {
        await tx.update(jobs).set({ completedAt: this.now() }).where(eq(jobs.id, job.id));
        return { skipped: true } as const;
      }
      const [leased] = await tx
        .update(jobs)
        .set({
          attempts: job.attempts + 1,
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(this.now().getTime() + 30000),
        })
        .where(eq(jobs.id, job.id))
        .returning();
      return { job: leased!, subscription };
    });
    if (!claimed) return false;
    if ('skipped' in claimed) return true;
    let success = false,
      gone = false;
    try {
      await this.send(
        {
          endpoint: claimed.subscription.endpoint,
          keys: { p256dh: claimed.subscription.p256dh, auth: claimed.subscription.auth },
        },
        JSON.stringify({
          type: 'chat',
          title: 'New website chat',
          body: 'A visitor is waiting in your LA Mattress inbox.',
          url: '/chat',
          tag: `chat-${claimed.job.conversationId}`,
        }),
      );
      success = true;
    } catch (error) {
      gone = [404, 410].includes(Number((error as { statusCode?: number }).statusCode));
    }
    await withDrizzleTenantContext(this.db, { businessId }, async (tx) => {
      if (gone) {
        await tx
          .delete(subscriptions)
          .where(
            and(
              eq(subscriptions.businessId, businessId),
              eq(subscriptions.id, claimed.subscription.id),
            ),
          );
        return;
      }
      await tx
        .update(jobs)
        .set({
          leaseToken: null,
          leaseExpiresAt: null,
          ...(success
            ? { completedAt: this.now() }
            : claimed.job.attempts >= 8
              ? { failedAt: this.now() }
              : {
                  availableAt: new Date(
                    this.now().getTime() + Math.min(60000, 1000 * 2 ** claimed.job.attempts),
                  ),
                }),
        })
        .where(
          and(
            eq(jobs.businessId, businessId),
            eq(jobs.id, claimed.job.id),
            eq(jobs.leaseToken, claimed.job.leaseToken!),
          ),
        );
    });
    return true;
  }
}
export function vapidSender(subject: string, publicKey: string, privateKey: string): PushSender {
  return (subscription, payload) =>
    webpush.sendNotification(subscription, payload, {
      TTL: 300,
      urgency: 'high',
      timeout: 10000,
      vapidDetails: { subject, publicKey, privateKey },
    });
}
