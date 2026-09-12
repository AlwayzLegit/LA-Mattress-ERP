import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema, withDrizzleTenantContext, type DrizzleTransaction } from '@jetnine/db';
import {
  chatPushSubscriptionSchema,
  chatFollowupSchema,
  chatAvailabilitySchema,
  chatActivitySchema,
  chatWorkflowSchema,
  chatHistoryQuerySchema,
  chatMessageInputSchema,
  type ChatHistoryPage,
  type VisitorChatMessage,
} from '@jetnine/shared';
import { z } from 'zod';
import type { RequestTenantContext } from '../tenancy/request-context';

const {
  chatIntegrations: integrations,
  chatSessions: sessions,
  chatConversations: conversations,
  chatMessages: messages,
  chatOutbox: outbox,
} = schema;
export const hashChatCredential = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export interface ChatIntegrationAuth {
  integrationId: string;
  credential: string;
}
export interface ChatVisitorAuth extends ChatIntegrationAuth {
  sessionCredential: string;
}
type MessageRow = typeof messages.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;
type Actor = { type: 'visitor' | 'staff'; id: string; audience: 'public' | 'internal' };

/** Pass the root DB. Each operation owns its RLS transaction and resolves only
 * after commit. HTTP routes are disabled by default through ChatHttpGuard. */
export class ChatService {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly environment: 'staging' | 'production',
  ) {}

  private async integration(auth: ChatIntegrationAuth) {
    if (
      !z.string().uuid().safeParse(auth.integrationId).success ||
      !/^[A-Za-z0-9_-]{43}$/.test(auth.credential)
    )
      throw new UnauthorizedException('Invalid chat integration');
    // Narrow credential lookup is the only unscoped read. Business is derived
    // from the authenticated integration, never from visitor input.
    const [row] = await this.db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.id, auth.integrationId),
          eq(integrations.credentialHash, hashChatCredential(auth.credential)),
          eq(integrations.enabled, true),
          eq(integrations.environment, this.environment),
        ),
      )
      .limit(1);
    if (!row) throw new UnauthorizedException('Invalid chat integration');
    return row;
  }

  private async integrationInTransaction(
    tx: DrizzleTransaction,
    auth: ChatIntegrationAuth,
    businessId: string,
  ) {
    const [row] = await tx
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.businessId, businessId),
          eq(integrations.id, auth.integrationId),
          eq(integrations.credentialHash, hashChatCredential(auth.credential)),
          eq(integrations.enabled, true),
          eq(integrations.environment, this.environment),
        ),
      )
      .for('share');
    if (!row) throw new UnauthorizedException('Invalid chat integration');
  }

  async createSession(auth: ChatIntegrationAuth) {
    const integration = await this.integration(auth);
    const credential = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await withDrizzleTenantContext(this.db, { businessId: integration.businessId }, async (tx) => {
      await this.integrationInTransaction(tx, auth, integration.businessId);
      await tx.insert(sessions).values({
        businessId: integration.businessId,
        integrationId: integration.id,
        credentialHash: hashChatCredential(credential),
        expiresAt,
      });
    });
    // Adapter must set an HttpOnly cookie, never return this to browser JS.
    return { credential, expiresAt: expiresAt.toISOString() };
  }

  private async visitor<T>(
    auth: ChatVisitorAuth,
    fn: (tx: DrizzleTransaction, session: typeof sessions.$inferSelect) => Promise<T>,
  ): Promise<T> {
    const integration = await this.integration(auth);
    if (!/^[A-Za-z0-9_-]{43}$/.test(auth.sessionCredential))
      throw new UnauthorizedException('Chat session expired');
    return withDrizzleTenantContext(this.db, { businessId: integration.businessId }, async (tx) => {
      await this.integrationInTransaction(tx, auth, integration.businessId);
      const [session] = await tx
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.businessId, integration.businessId),
            eq(sessions.integrationId, integration.id),
            eq(sessions.credentialHash, hashChatCredential(auth.sessionCredential)),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, new Date()),
          ),
        )
        .for('update');
      if (!session) throw new UnauthorizedException('Chat session expired');
      return fn(tx, session);
    });
  }

  async startConversation(auth: ChatVisitorAuth, clientConversationId: string, input: unknown) {
    this.uuid(clientConversationId);
    const message = this.input(input);
    return this.visitor(auth, async (tx, session) => {
      // Session lock serializes concurrent create retries before inserting.
      let [conversation] = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.businessId, session.businessId),
            eq(conversations.sessionId, session.id),
            eq(conversations.clientConversationId, clientConversationId),
          ),
        )
        .for('update');
      if (!conversation)
        [conversation] = await tx
          .insert(conversations)
          .values({
            businessId: session.businessId,
            sessionId: session.id,
            clientConversationId,
          })
          .returning();
      // A retried creation may not silently become another message.
      if (conversation!.lastSequence > 0) {
        const [first] = await tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.businessId, session.businessId),
              eq(messages.conversationId, conversation!.id),
              eq(messages.sequence, 1),
            ),
          );
        if (
          !first ||
          first.clientMessageId !== message.clientMessageId ||
          first.body !== message.body
        )
          throw new ConflictException('Conversation creation key already used');
        return { conversationId: conversation!.id, message: this.publicMessage(first) };
      }
      const saved = await this.append(
        tx,
        conversation!,
        { type: 'visitor', id: session.id, audience: 'public' },
        message,
      );
      return { conversationId: conversation!.id, message: this.publicMessage(saved) };
    });
  }

  async sendVisitorMessage(
    auth: ChatVisitorAuth,
    conversationId: string,
    input: unknown,
  ): Promise<VisitorChatMessage> {
    this.uuid(conversationId);
    const message = this.input(input);
    return this.visitor(auth, async (tx, session) => {
      const conversation = await this.conversation(
        tx,
        session.businessId,
        conversationId,
        session.id,
      );
      return this.publicMessage(
        await this.append(
          tx,
          conversation,
          { type: 'visitor', id: session.id, audience: 'public' },
          message,
        ),
      );
    });
  }

  async visitorFollowup(auth: ChatVisitorAuth, id: string, body: unknown) {
    this.uuid(id);
    const parsed = chatFollowupSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(
        'Enter your name and a valid contact method, then consent to a reply.',
      );
    return this.visitor(auth, async (tx, session) => {
      const row = await this.conversation(tx, session.businessId, id, session.id);
      if (row.status === 'spam') throw new ForbiddenException('Conversation unavailable');
      await tx
        .update(conversations)
        .set({
          followupName: parsed.data.name,
          followupMethod: parsed.data.method,
          followupContact: parsed.data.contact,
          followupRequestedAt: new Date(),
          followupCompletedAt: null,
          status: 'queued',
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(conversations.businessId, session.businessId), eq(conversations.id, id)));
      return { saved: true };
    });
  }
  async endVisitorChat(auth: ChatVisitorAuth, id: string) {
    this.uuid(id);
    return this.visitor(auth, async (tx, session) => {
      const row = await this.conversation(tx, session.businessId, id, session.id);
      if (row.status !== 'spam')
        await tx
          .update(conversations)
          .set({
            status: 'resolved',
            visitorTypingUntil: null,
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(conversations.businessId, session.businessId), eq(conversations.id, id)));
      return { ended: true };
    });
  }
  async followup(tenant: RequestTenantContext, id: string, complete = false) {
    this.uuid(id);
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        await this.requireStaff(tx, tenant, complete);
        const row = await this.conversation(tx, tenant.businessId!, id);
        if (complete && row.followupRequestedAt) {
          await tx
            .update(conversations)
            .set({ followupCompletedAt: new Date(), version: row.version + 1 })
            .where(and(eq(conversations.businessId, tenant.businessId!), eq(conversations.id, id)));
          await tx.insert(schema.auditLogs).values({
            businessId: tenant.businessId!,
            actorUserId: tenant.userId!,
            actorType: 'user',
            action: 'chat.followup_completed',
            targetType: 'chat_conversation',
            targetId: id,
            changesJson: {},
          });
        }
        return {
          name: row.followupName,
          method: row.followupMethod,
          contact: row.followupContact,
          requestedAt: row.followupRequestedAt,
          completedAt: complete ? new Date() : row.followupCompletedAt,
          verified: false,
        };
      },
    );
  }

  async visitorHistory(
    auth: ChatVisitorAuth,
    conversationId: string,
    query: unknown = {},
  ): Promise<ChatHistoryPage> {
    this.uuid(conversationId);
    const parsed = chatHistoryQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Invalid history cursor');
    const { afterSequence, limit } = parsed.data;
    return this.visitor(auth, async (tx, session) => {
      const conversation = await this.conversation(
        tx,
        session.businessId,
        conversationId,
        session.id,
      );
      const rows = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.businessId, session.businessId),
            eq(messages.conversationId, conversationId),
            eq(messages.audience, 'public'),
            gt(messages.sequence, afterSequence),
          ),
        )
        .orderBy(asc(messages.sequence))
        .limit(limit + 1);
      const [available] = await tx
        .select({ id: schema.chatAgents.id })
        .from(schema.chatAgents)
        .innerJoin(
          schema.memberships,
          and(
            eq(schema.memberships.id, schema.chatAgents.membershipId),
            eq(schema.memberships.businessId, session.businessId),
            eq(schema.memberships.status, 'active'),
          ),
        )
        .where(
          and(
            eq(schema.chatAgents.businessId, session.businessId),
            eq(schema.chatAgents.available, true),
            sql`${schema.chatAgents.heartbeatUntil} > now()`,
          ),
        )
        .limit(1);
      const visible = rows.slice(0, limit);
      return {
        data: visible.map((row) => this.publicMessage(row)),
        activity: {
          teamAvailable: Boolean(available),
          staffReadSequence: conversation.staffReadSequence,
          typing: Boolean(
            conversation.staffTypingUntil && conversation.staffTypingUntil > new Date(),
          ),
          status: conversation.status,
        },
        nextSequence: visible.at(-1)?.sequence ?? afterSequence,
        hasMore: rows.length > limit,
      };
    });
  }

  /** Only business-wide staff access in this foundation. Store/team routing and
   * assigned-only access fail closed until scoped queues are implemented. */
  async sendStaffMessage(
    tenant: RequestTenantContext,
    conversationId: string,
    input: unknown,
    kind: 'reply' | 'note' = 'reply',
  ) {
    this.uuid(conversationId);
    const message = this.input(input);
    if (
      !tenant.businessId ||
      !tenant.userId ||
      !tenant.membershipId ||
      tenant.apiKeyId ||
      tenant.dataScope !== 'all' ||
      !tenant.permissions.has('chat.view_team') ||
      !tenant.permissions.has('chat.reply')
    )
      throw new ForbiddenException('Chat team reply permission required');
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        const member = await this.requireStaff(tx, tenant, true);
        const conversation = await this.conversation(tx, tenant.businessId!, conversationId);
        const saved = await this.append(
          tx,
          conversation,
          { type: 'staff', id: member.id, audience: kind === 'note' ? 'internal' : 'public' },
          message,
        );
        await tx.insert(schema.auditLogs).values({
          businessId: tenant.businessId!,
          actorUserId: tenant.userId!,
          actorType: 'user',
          impersonatorUserId: tenant.impersonatorUserId,
          action: kind === 'note' ? 'chat.note.write' : 'chat.reply.write',
          targetType: 'chat_conversation',
          targetId: conversation.id,
          changesJson: { messageId: saved.id, sequence: saved.sequence },
        });
        return {
          id: saved.id,
          conversationId: saved.conversationId,
          sequence: saved.sequence,
          body: saved.body,
          audience: saved.audience,
          createdAt: saved.createdAt.toISOString(),
          persisted: true as const,
        };
      },
    );
  }

  async startFromHttp(auth: ChatVisitorAuth, body: unknown) {
    const parsed = chatMessageInputSchema
      .extend({ clientConversationId: z.string().uuid() })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid conversation request');
    const { clientConversationId, ...message } = parsed.data;
    return this.startConversation(auth, clientConversationId, message);
  }

  private async requireStaff(
    tx: DrizzleTransaction,
    tenant: RequestTenantContext,
    reply: boolean | 'chat.assign' | 'chat.manage' | 'chat.export' = false,
  ) {
    if (
      !tenant.businessId ||
      !tenant.userId ||
      !tenant.membershipId ||
      tenant.apiKeyId ||
      tenant.dataScope !== 'all' ||
      !tenant.permissions.has('chat.view_team')
    )
      throw new ForbiddenException('Chat team permission required');
    const [member] = await tx
      .select()
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.businessId, tenant.businessId!),
          eq(schema.memberships.id, tenant.membershipId!),
          eq(schema.memberships.userId, tenant.userId!),
          eq(schema.memberships.status, 'active'),
          eq(schema.memberships.dataScope, 'all'),
        ),
      )
      .for('share');
    if (!member) throw new ForbiddenException('Active chat membership required');
    const rolePermissions = await tx
      .select()
      .from(schema.rolePermissions)
      .where(eq(schema.rolePermissions.roleId, member.roleId));
    const overrides = await tx
      .select()
      .from(schema.membershipPermissionOverrides)
      .where(
        and(
          eq(schema.membershipPermissionOverrides.businessId, tenant.businessId!),
          eq(schema.membershipPermissionOverrides.membershipId, member.id),
        ),
      );
    const effective = new Set(rolePermissions.map((row) => row.permission));
    for (const override of overrides) {
      if (override.allowed) effective.add(override.permission);
      else effective.delete(override.permission);
    }
    if (
      !effective.has('chat.view_team') ||
      (reply && !effective.has(reply === true ? 'chat.reply' : reply))
    )
      throw new ForbiddenException('Chat team reply permission required');

    return member;
  }

  /** Metadata only; each snapshot rechecks membership and runs under tenant RLS. */
  async staffLiveSnapshot(tenant: RequestTenantContext) {
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        await this.requireStaff(tx, tenant);
        await tx
          .update(conversations)
          .set({ status: 'open', snoozedUntil: null, version: sql`${conversations.version} + 1` })
          .where(
            and(
              eq(conversations.businessId, tenant.businessId!),
              eq(conversations.status, 'snoozed'),
              sql`${conversations.snoozedUntil} <= now()`,
            ),
          );
        return tx
          .select({
            id: conversations.id,
            version: conversations.version,
            followupPending: sql<boolean>`${conversations.followupRequestedAt} is not null and ${conversations.followupCompletedAt} is null`,
            assignedMembershipId: conversations.assignedMembershipId,
            assignedToMe: sql<boolean>`${conversations.assignedMembershipId} = ${tenant.membershipId}`,
            visitorReadSequence: conversations.visitorReadSequence,
            staffReadSequence: conversations.staffReadSequence,
            visitorTyping: sql<boolean>`coalesce(${conversations.visitorTypingUntil} > now(), false)`,
            status: conversations.status,
            updatedAt: conversations.updatedAt,
            lastSequence: conversations.lastSequence,
            visitorSequence:
              sql<number>`coalesce((select max(m.sequence) from chat_messages m where m.business_id = "chat_conversations"."business_id" and m.conversation_id = "chat_conversations"."id" and m.sender_type = 'visitor' and m.audience = 'public'), 0)`.mapWith(
                Number,
              ),
          })
          .from(conversations)
          .where(eq(conversations.businessId, tenant.businessId!));
      },
    );
  }

  async staffConversations(tenant: RequestTenantContext, query: unknown = {}) {
    const parsed = z
      .object({
        afterId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict()
      .safeParse(query);
    if (!parsed.success) throw new BadRequestException('Invalid inbox cursor');
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        await this.requireStaff(tx, tenant);
        const rows = await tx
          .select({
            id: conversations.id,
            status: conversations.status,
            updatedAt: conversations.updatedAt,
            lastSequence: conversations.lastSequence,
          })
          .from(conversations)
          .where(
            and(
              eq(conversations.businessId, tenant.businessId!),
              parsed.data.afterId ? gt(conversations.id, parsed.data.afterId) : undefined,
            ),
          )
          .orderBy(asc(conversations.id))
          .limit(parsed.data.limit + 1);
        const data = rows.slice(0, parsed.data.limit);
        return {
          data,
          hasMore: rows.length > parsed.data.limit,
          nextCursor: data.at(-1)?.id ?? null,
        };
      },
    );
  }

  async availability(tenant: RequestTenantContext, body?: unknown) {
    const parsed = body === undefined ? null : chatAvailabilitySchema.safeParse(body);
    if (parsed && !parsed.success) throw new BadRequestException('Invalid availability');
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        await this.requireStaff(tx, tenant, true);
        if (parsed?.success)
          await tx
            .insert(schema.chatAgents)
            .values({
              businessId: tenant.businessId!,
              membershipId: tenant.membershipId!,
              ...parsed.data,
              heartbeatUntil: parsed.data.available ? new Date(Date.now() + 45000) : null,
            })
            .onConflictDoUpdate({
              target: [schema.chatAgents.businessId, schema.chatAgents.membershipId],
              set: {
                ...parsed.data,
                heartbeatUntil: parsed.data.available ? new Date(Date.now() + 45000) : null,
              },
            });
        const [agent] = await tx
          .select()
          .from(schema.chatAgents)
          .where(
            and(
              eq(schema.chatAgents.businessId, tenant.businessId!),
              eq(schema.chatAgents.membershipId, tenant.membershipId!),
            ),
          );
        return { available: agent?.available ?? false, capacity: agent?.capacity ?? 5 };
      },
    );
  }
  async operations(tenant: RequestTenantContext) {
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        await this.requireStaff(tx, tenant, 'chat.manage');
        const [delivery] = await tx
          .select({
            pending:
              sql<number>`count(*) filter (where completed_at is null and failed_at is null)`.mapWith(
                Number,
              ),
            failed: sql<number>`count(*) filter (where failed_at is not null)`.mapWith(Number),
          })
          .from(outbox)
          .where(eq(outbox.businessId, tenant.businessId!));
        const [push] = await tx
          .select({
            pending:
              sql<number>`count(*) filter (where completed_at is null and failed_at is null)`.mapWith(
                Number,
              ),
            failed: sql<number>`count(*) filter (where failed_at is not null)`.mapWith(Number),
          })
          .from(schema.chatPushDeliveries)
          .where(eq(schema.chatPushDeliveries.businessId, tenant.businessId!));
        return { transport: delivery, push };
      },
    );
  }
  async retryFailed(tenant: RequestTenantContext) {
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        await this.requireStaff(tx, tenant, 'chat.manage');
        const result = await tx
          .update(outbox)
          .set({
            failedAt: null,
            attempts: 0,
            availableAt: new Date(),
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(
            and(eq(outbox.businessId, tenant.businessId!), sql`${outbox.failedAt} is not null`),
          )
          .returning({ id: outbox.id });
        const push = await tx
          .update(schema.chatPushDeliveries)
          .set({
            failedAt: null,
            attempts: 0,
            availableAt: new Date(),
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(
            and(
              eq(schema.chatPushDeliveries.businessId, tenant.businessId!),
              sql`${schema.chatPushDeliveries.failedAt} is not null`,
            ),
          )
          .returning({ id: schema.chatPushDeliveries.id });
        await tx.insert(schema.auditLogs).values({
          businessId: tenant.businessId!,
          actorUserId: tenant.userId!,
          actorType: 'user',
          action: 'chat.delivery.retry',
          targetType: 'chat_delivery',
          changesJson: { count: result.length + push.length },
        });
        return { retried: result.length + push.length };
      },
    );
  }

  async subscribePush(tenant: RequestTenantContext, body: unknown) {
    const parsed = chatPushSubscriptionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid push subscription');
    const url = new URL(parsed.data.endpoint);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      ![
        'fcm.googleapis.com',
        'updates.push.services.mozilla.com',
        'web.push.apple.com',
        'wns2.notify.windows.com',
      ].some((host) => url.hostname === host || url.hostname.endsWith('.' + host))
    )
      throw new BadRequestException('Unsupported browser push service');
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        await this.requireStaff(tx, tenant);
        await tx
          .insert(schema.chatPushSubscriptions)
          .values({
            businessId: tenant.businessId!,
            userId: tenant.userId!,
            membershipId: tenant.membershipId!,
            environment: this.environment,
            endpoint: parsed.data.endpoint,
            ...parsed.data.keys,
          })
          .onConflictDoUpdate({
            target: [
              schema.chatPushSubscriptions.businessId,
              schema.chatPushSubscriptions.endpoint,
            ],
            set: {
              userId: tenant.userId!,
              membershipId: tenant.membershipId!,
              ...parsed.data.keys,
            },
          });
        return { subscribed: true };
      },
    );
  }
  async unsubscribePush(tenant: RequestTenantContext, body: unknown) {
    const parsed = z
      .object({ endpoint: z.string().max(2048) })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid subscription');
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        await this.requireStaff(tx, tenant);
        await tx
          .delete(schema.chatPushSubscriptions)
          .where(
            and(
              eq(schema.chatPushSubscriptions.businessId, tenant.businessId!),
              eq(schema.chatPushSubscriptions.userId, tenant.userId!),
              eq(schema.chatPushSubscriptions.endpoint, parsed.data.endpoint),
            ),
          );
        return { subscribed: false };
      },
    );
  }

  async activity(
    tenant: RequestTenantContext | null,
    auth: ChatVisitorAuth | null,
    id: string,
    body: unknown,
  ) {
    this.uuid(id);
    const parsed = chatActivitySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid activity');
    const update = async (tx: DrizzleTransaction, row: ConversationRow, staff: boolean) => {
      const current = staff ? row.staffReadSequence : row.visitorReadSequence;
      // Acknowledge only persisted public messages, never internal-note sequences.
      const [last] = await tx
        .select({ sequence: messages.sequence })
        .from(messages)
        .where(
          and(
            eq(messages.businessId, row.businessId),
            eq(messages.conversationId, id),
            eq(messages.audience, 'public'),
            sql`${messages.sequence} <= ${Math.min(row.lastSequence, parsed.data.readSequence ?? current)}`,
          ),
        )
        .orderBy(sql`${messages.sequence} desc`)
        .limit(1);
      await tx
        .update(conversations)
        .set({
          ...(parsed.data.readSequence !== undefined
            ? staff
              ? { staffReadSequence: Math.max(current, last?.sequence ?? 0) }
              : { visitorReadSequence: Math.max(current, last?.sequence ?? 0) }
            : {}),
          ...(parsed.data.typing !== undefined
            ? staff
              ? { staffTypingUntil: parsed.data.typing ? new Date(Date.now() + 6000) : null }
              : { visitorTypingUntil: parsed.data.typing ? new Date(Date.now() + 6000) : null }
            : {}),
        })
        .where(and(eq(conversations.businessId, row.businessId), eq(conversations.id, id)));
      return { saved: true };
    };
    if (auth)
      return this.visitor(auth, async (tx, session) =>
        update(tx, await this.conversation(tx, session.businessId, id, session.id), false),
      );
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant!.businessId, userId: tenant!.userId },
      async (tx) => {
        await this.requireStaff(tx, tenant!, true);
        return update(tx, await this.conversation(tx, tenant!.businessId!, id), true);
      },
    );
  }

  async workflow(tenant: RequestTenantContext, id: string, body: unknown) {
    this.uuid(id);
    const parsed = chatWorkflowSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid workflow action');
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        await this.requireStaff(tx, tenant, 'chat.assign');
        const row = await this.conversation(tx, tenant.businessId!, id);
        if (row.version !== parsed.data.version)
          throw new ConflictException('Conversation changed. Review its latest state and retry.');
        const action = parsed.data.action;
        if (action === 'claim' && row.assignedMembershipId !== tenant.membershipId) {
          const [agent] = await tx
            .select()
            .from(schema.chatAgents)
            .where(
              and(
                eq(schema.chatAgents.businessId, tenant.businessId!),
                eq(schema.chatAgents.membershipId, tenant.membershipId!),
              ),
            )
            .for('update');
          if (agent) {
            const [count] = await tx
              .select({ value: sql<number>`count(*)`.mapWith(Number) })
              .from(conversations)
              .where(
                and(
                  eq(conversations.businessId, tenant.businessId!),
                  eq(conversations.assignedMembershipId, tenant.membershipId!),
                  sql`${conversations.status} in ('open', 'waiting_customer', 'queued')`,
                ),
              );
            if (count!.value >= agent.capacity)
              throw new ConflictException(
                'Your chat capacity is full. Resolve or release a conversation first.',
              );
          }
        }

        if (
          action === 'claim' &&
          row.assignedMembershipId &&
          row.assignedMembershipId !== tenant.membershipId
        )
          throw new ConflictException('Another teammate already owns this chat.');
        if (row.assignedMembershipId && row.assignedMembershipId !== tenant.membershipId)
          await this.requireStaff(tx, tenant, 'chat.manage');
        const until = parsed.data.snoozedUntil ? new Date(parsed.data.snoozedUntil) : null;
        if (
          action === 'snooze' &&
          (!until || until.getTime() <= Date.now() || until.getTime() > Date.now() + 7 * 86400000)
        )
          throw new BadRequestException('Choose a snooze time within seven days');
        const [updated] = await tx
          .update(conversations)
          .set({
            version: row.version + 1,
            updatedAt: new Date(),
            ...(action === 'claim'
              ? { assignedMembershipId: tenant.membershipId, status: 'open' }
              : {}),
            ...(action === 'release' ? { assignedMembershipId: null, status: 'queued' } : {}),
            ...(action === 'resolve' ? { status: 'resolved' } : {}),
            ...(action === 'spam' ? { status: 'spam' } : {}),
            ...(action === 'reopen'
              ? { status: row.assignedMembershipId ? 'open' : 'queued' }
              : {}),
            snoozedUntil: action === 'snooze' ? until : null,
            ...(action === 'snooze' ? { status: 'snoozed' } : {}),
          })
          .where(and(eq(conversations.businessId, tenant.businessId!), eq(conversations.id, id)))
          .returning();
        await tx.insert(schema.auditLogs).values({
          businessId: tenant.businessId!,
          actorUserId: tenant.userId!,
          actorType: 'user',
          action: `chat.${action}`,
          targetType: 'chat_conversation',
          targetId: id,
          changesJson: { version: updated!.version },
        });
        return { saved: true, version: updated!.version };
      },
    );
  }

  async exportTranscript(tenant: RequestTenantContext, id: string) {
    this.uuid(id);
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        await this.requireStaff(tx, tenant, 'chat.export');
        await this.conversation(tx, tenant.businessId!, id);
        const rows = await tx
          .select({
            sender: messages.senderType,
            body: messages.body,
            createdAt: messages.createdAt,
            sequence: messages.sequence,
          })
          .from(messages)
          .where(
            and(
              eq(messages.businessId, tenant.businessId!),
              eq(messages.conversationId, id),
              eq(messages.audience, 'public'),
            ),
          )
          .orderBy(asc(messages.sequence));
        await tx.insert(schema.auditLogs).values({
          businessId: tenant.businessId!,
          actorUserId: tenant.userId!,
          actorType: 'user',
          action: 'chat.export',
          targetType: 'chat_conversation',
          targetId: id,
          changesJson: { messageCount: rows.length },
        });
        return { conversationId: id, messages: rows };
      },
    );
  }

  async staffHistory(tenant: RequestTenantContext, conversationId: string, query: unknown = {}) {
    this.uuid(conversationId);
    const parsed = chatHistoryQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Invalid history cursor');
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        await this.requireStaff(tx, tenant);
        await this.conversation(tx, tenant.businessId!, conversationId);
        const rows = await tx
          .select({
            id: messages.id,
            conversationId: messages.conversationId,
            body: messages.body,
            sender: messages.senderType,
            audience: messages.audience,
            sequence: messages.sequence,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(
            and(
              eq(messages.businessId, tenant.businessId!),
              eq(messages.conversationId, conversationId),
              gt(messages.sequence, parsed.data.afterSequence),
            ),
          )
          .orderBy(asc(messages.sequence))
          .limit(parsed.data.limit + 1);
        const data = rows.slice(0, parsed.data.limit);
        return {
          data,
          hasMore: rows.length > parsed.data.limit,
          nextSequence: data.at(-1)?.sequence ?? parsed.data.afterSequence,
        };
      },
    );
  }

  private async conversation(
    tx: DrizzleTransaction,
    businessId: string,
    id: string,
    sessionId?: string,
  ) {
    const [row] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.businessId, businessId),
          eq(conversations.id, id),
          sessionId ? eq(conversations.sessionId, sessionId) : undefined,
        ),
      )
      .for('update');
    if (!row) throw new NotFoundException('Conversation not found');
    return row;
  }

  private async append(
    tx: DrizzleTransaction,
    conversation: ConversationRow,
    actor: Actor,
    input: z.infer<typeof chatMessageInputSchema>,
  ) {
    const fingerprint = hashChatCredential(JSON.stringify([actor.audience, input.body]));
    const [existing] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.businessId, conversation.businessId),
          eq(messages.conversationId, conversation.id),
          eq(messages.senderType, actor.type),
          eq(messages.senderId, actor.id),
          eq(messages.clientMessageId, input.clientMessageId),
        ),
      );
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new ConflictException('Message ID already used with different content');
      return existing;
    }
    if (conversation.status === 'spam') throw new ConflictException('Conversation is closed');
    const sequence = conversation.lastSequence + 1;
    const [saved] = await tx
      .insert(messages)
      .values({
        businessId: conversation.businessId,
        conversationId: conversation.id,
        sequence,
        senderType: actor.type,
        senderId: actor.id,
        audience: actor.audience,
        body: input.body,
        fingerprint,
        clientMessageId: input.clientMessageId,
      })
      .returning();
    await tx
      .update(conversations)
      .set({
        lastSequence: sequence,
        version: conversation.version + 1,
        updatedAt: saved!.createdAt,
        status:
          actor.audience === 'internal'
            ? conversation.status
            : actor.type === 'staff'
              ? 'waiting_customer'
              : conversation.status === 'queued'
                ? 'queued'
                : 'open',
      })
      .where(
        and(
          eq(conversations.businessId, conversation.businessId),
          eq(conversations.id, conversation.id),
        ),
      );
    const audiences = actor.audience === 'public' ? ['staff', 'visitor'] : ['staff'];
    await tx.insert(outbox).values(
      audiences.map((audience) => ({
        businessId: conversation.businessId,
        conversationId: conversation.id,
        sequence,
        audience,
      })),
    );
    if (actor.type === 'visitor') {
      const subscriptions = await tx
        .select()
        .from(schema.chatPushSubscriptions)
        .where(
          and(
            eq(schema.chatPushSubscriptions.businessId, conversation.businessId),
            eq(schema.chatPushSubscriptions.environment, this.environment),
          ),
        );
      if (subscriptions.length)
        await tx.insert(schema.chatPushDeliveries).values(
          subscriptions.map((subscription) => ({
            businessId: conversation.businessId,
            subscriptionId: subscription.id,
            conversationId: conversation.id,
            sequence,
          })),
        );
    }
    return saved!;
  }

  private publicMessage(row: MessageRow): VisitorChatMessage {
    if (row.audience !== 'public') throw new Error('Private message cannot enter visitor output');
    return {
      id: row.id,
      conversationId: row.conversationId,
      sequence: row.sequence,
      sender: row.senderType as 'visitor' | 'staff',
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      persisted: true,
    };
  }
  private uuid(id: string) {
    if (!z.string().uuid().safeParse(id).success) throw new BadRequestException('Invalid chat ID');
  }
  private input(input: unknown) {
    const parsed = chatMessageInputSchema.safeParse(input);
    if (!parsed.success)
      throw new BadRequestException(
        'Write a message of 1–4000 characters with a valid client message ID',
      );
    return parsed.data;
  }
}
