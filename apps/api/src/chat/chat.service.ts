import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema, withDrizzleTenantContext, type DrizzleTransaction } from '@jetnine/db';
import {
  chatPushSubscriptionSchema,
  chatSettingsSchema,
  chatContextSchema,
  chatTransferSchema,
  chatLinkSchema,
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
import { withinChatHours } from './chat-policy';
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

  private async settingsIn(tx: DrizzleTransaction, businessId: string) {
    const [row] = await tx
      .select()
      .from(schema.chatSettings)
      .where(eq(schema.chatSettings.businessId, businessId));
    return { config: chatSettingsSchema.parse(row?.configJson ?? {}), version: row?.version ?? 0 };
  }
  private async manager(tx: DrizzleTransaction, tenant: RequestTenantContext) {
    const member = await this.requireStaff(tx, tenant, 'chat.manage');
    if (member.dataScope !== 'all' || !member.canViewTeam)
      throw new ForbiddenException('Business-wide chat manager access required');
    return member;
  }
  async settings(tenant: RequestTenantContext, body?: unknown) {
    const parsed =
      body === undefined
        ? null
        : z
            .object({ config: chatSettingsSchema, version: z.number().int().min(0) })
            .strict()
            .safeParse(body);
    if (parsed && !parsed.success) throw new BadRequestException('Invalid chat settings');
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        await this.manager(tx, tenant);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenant.businessId!}))`);
        const current = await this.settingsIn(tx, tenant.businessId!);
        if (!parsed?.success) return current;
        if (current.version !== parsed.data.version)
          throw new ConflictException('Settings changed. Refresh before saving.');
        const version = current.version + 1;
        await tx
          .insert(schema.chatSettings)
          .values({ businessId: tenant.businessId!, configJson: parsed.data.config, version })
          .onConflictDoUpdate({
            target: schema.chatSettings.businessId,
            set: { configJson: parsed.data.config, version, updatedAt: new Date() },
          });
        await this.audit(tx, tenant, 'chat.settings', tenant.businessId!, { version });
        return { config: parsed.data.config, version };
      },
    );
  }
  private async audit(
    tx: DrizzleTransaction,
    tenant: RequestTenantContext,
    action: string,
    id: string,
    changesJson: Record<string, unknown>,
  ) {
    await tx.insert(schema.auditLogs).values({
      businessId: tenant.businessId!,
      actorUserId: tenant.userId!,
      actorType: 'user',
      action,
      targetType: 'chat_conversation',
      targetId: id,
      changesJson,
    });
  }
  private async eligibleAgents(
    tx: DrizzleTransaction,
    businessId: string,
    locationId: string | null,
  ) {
    const members = await tx
      .select({ member: schema.memberships, agent: schema.chatAgents, name: schema.users.name })
      .from(schema.chatAgents)
      .innerJoin(
        schema.memberships,
        and(
          eq(schema.memberships.id, schema.chatAgents.membershipId),
          eq(schema.memberships.businessId, businessId),
        ),
      )
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(
        and(eq(schema.chatAgents.businessId, businessId), eq(schema.memberships.status, 'active')),
      );
    const eligible = [];
    for (const row of members) {
      const permissions = await tx
        .select()
        .from(schema.rolePermissions)
        .where(eq(schema.rolePermissions.roleId, row.member.roleId));
      const overrides = await tx
        .select()
        .from(schema.membershipPermissionOverrides)
        .where(
          and(
            eq(schema.membershipPermissionOverrides.businessId, businessId),
            eq(schema.membershipPermissionOverrides.membershipId, row.member.id),
          ),
        );
      const effective = new Set(permissions.map((p) => p.permission));
      for (const p of overrides) {
        if (p.allowed) effective.add(p.permission);
        else effective.delete(p.permission);
      }
      if (
        !effective.has('chat.reply') ||
        (!effective.has('chat.view_team') && !effective.has('chat.view_assigned'))
      )
        continue;
      if (row.member.dataScope !== 'all') {
        if (row.member.dataScope !== 'store' || !locationId) continue;
        const allowed = await tx
          .select()
          .from(schema.membershipLocationScopes)
          .where(
            and(
              eq(schema.membershipLocationScopes.businessId, businessId),
              eq(schema.membershipLocationScopes.membershipId, row.member.id),
              eq(schema.membershipLocationScopes.locationId, locationId),
            ),
          );
        if (!allowed.length) continue;
      }
      const [count] = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(conversations)
        .where(
          and(
            eq(conversations.businessId, businessId),
            eq(conversations.assignedMembershipId, row.member.id),
            sql`${conversations.status} in ('open','queued','waiting_customer')`,
          ),
        );
      eligible.push({
        id: row.member.id,
        name: row.name,
        available:
          row.agent.available &&
          Boolean(row.agent.heartbeatUntil && row.agent.heartbeatUntil > new Date()),
        capacity: row.agent.capacity,
        workload: count!.value,
        lastAssignedAt: row.agent.lastAssignedAt,
      });
    }
    return eligible.sort(
      (a, b) =>
        a.workload - b.workload ||
        (a.lastAssignedAt?.getTime() ?? 0) - (b.lastAssignedAt?.getTime() ?? 0) ||
        a.id.localeCompare(b.id),
    );
  }
  async context(tenant: RequestTenantContext, id: string) {
    this.uuid(id);
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        const row = await this.staffConversation(tx, tenant, id);
        const [settings, agents, history] = await Promise.all([
          this.settingsIn(tx, tenant.businessId!),
          this.eligibleAgents(tx, tenant.businessId!, row.locationId),
          tx
            .select({
              action: schema.auditLogs.action,
              at: schema.auditLogs.createdAt,
              changes: schema.auditLogs.changesJson,
            })
            .from(schema.auditLogs)
            .where(
              and(
                eq(schema.auditLogs.businessId, tenant.businessId!),
                eq(schema.auditLogs.targetId, id),
                sql`${schema.auditLogs.action} in ('chat.claim','chat.release','chat.transfer','chat.auto_assign','chat.assignment_expired','chat.resolve','chat.reopen')`,
              ),
            )
            .orderBy(schema.auditLogs.createdAt),
        ]);
        const [location] = row.locationId
          ? await tx
              .select({ name: schema.locations.name })
              .from(schema.locations)
              .where(
                and(
                  eq(schema.locations.businessId, tenant.businessId!),
                  eq(schema.locations.id, row.locationId),
                ),
              )
          : [];
        return {
          locationName: location?.name ?? null,
          context: row.contextJson,
          locationId: row.locationId,
          customerId: row.customerId,
          customerVerifiedAt: row.customerVerifiedAt,
          agents,
          assignmentHistory: history,
          templates: settings.config.templates,
          version: row.version,
        };
      },
    );
  }
  async visitorContext(auth: ChatVisitorAuth, id: string, body: unknown) {
    this.uuid(id);
    const parsed = chatContextSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid conversation context');
    return this.visitor(auth, async (tx, session) => {
      const row = await this.conversation(tx, session.businessId, id, session.id);
      if (row.assignedMembershipId)
        throw new ConflictException('Showroom cannot change after assignment');
      if (parsed.data.locationId) {
        const [location] = await tx
          .select()
          .from(schema.locations)
          .where(
            and(
              eq(schema.locations.id, parsed.data.locationId),
              eq(schema.locations.businessId, session.businessId),
            ),
          );
        if (!location) throw new BadRequestException('Unknown showroom');
      }
      await tx
        .update(conversations)
        .set({
          contextJson: parsed.data,
          locationId: parsed.data.locationId,
          version: row.version + 1,
        })
        .where(and(eq(conversations.businessId, session.businessId), eq(conversations.id, id)));
      return { saved: true };
    });
  }
  async visitorOptions(auth: ChatIntegrationAuth) {
    const integration = await this.integration(auth);
    return withDrizzleTenantContext(this.db, { businessId: integration.businessId }, async (tx) => {
      const settings = await this.settingsIn(tx, integration.businessId);
      const locations = await tx
        .select({ id: schema.locations.id, name: schema.locations.name })
        .from(schema.locations)
        .where(
          and(
            eq(schema.locations.businessId, integration.businessId),
            eq(schema.locations.locationType, 'store'),
          ),
        );
      return {
        enabled: settings.config.enabled,
        withinHours: withinChatHours(settings.config),
        locations,
      };
    });
  }
  async acceptAssignment(tenant: RequestTenantContext, id: string) {
    this.uuid(id);
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        await this.requireStaff(tx, tenant, true);
        const row = await this.staffConversation(tx, tenant, id);
        if (row.assignedMembershipId !== tenant.membershipId)
          throw new ForbiddenException('Only the assigned teammate can accept');
        await tx
          .update(conversations)
          .set({ acceptedAt: new Date(), version: row.version + 1 })
          .where(and(eq(conversations.businessId, tenant.businessId!), eq(conversations.id, id)));
        await this.audit(tx, tenant, 'chat.accept', id, {});
        return { saved: true };
      },
    );
  }
  async rating(auth: ChatVisitorAuth, id: string, body: unknown) {
    this.uuid(id);
    const parsed = z
      .object({ rating: z.number().int().min(1).max(5) })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException('Choose a rating from one to five');
    return this.visitor(auth, async (tx, session) => {
      const row = await this.conversation(tx, session.businessId, id, session.id);
      if (row.status !== 'resolved') throw new ConflictException('Rate a completed conversation');
      await tx
        .update(conversations)
        .set({ rating: parsed.data.rating })
        .where(and(eq(conversations.businessId, session.businessId), eq(conversations.id, id)));
      return { saved: true };
    });
  }
  async transfer(tenant: RequestTenantContext, id: string, body: unknown) {
    this.uuid(id);
    const parsed = chatTransferSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Choose a teammate');
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        await this.requireStaff(tx, tenant, 'chat.assign');
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenant.businessId!}))`);
        const row = await this.staffConversation(tx, tenant, id);
        if (row.version !== parsed.data.version)
          throw new ConflictException('Conversation changed. Refresh and retry.');
        if (row.assignedMembershipId && row.assignedMembershipId !== tenant.membershipId)
          await this.manager(tx, tenant);
        const target = (await this.eligibleAgents(tx, tenant.businessId!, row.locationId)).find(
          (agent) => agent.id === parsed.data.membershipId,
        );
        if (
          !target ||
          !target.available ||
          (target.workload >= target.capacity && row.assignedMembershipId !== target.id)
        )
          throw new ConflictException('Teammate is unavailable or at capacity');
        await tx
          .update(conversations)
          .set({
            assignedMembershipId: target.id,
            assignedAt: new Date(),
            acceptedAt: null,
            status: 'open',
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(conversations.businessId, tenant.businessId!), eq(conversations.id, id)));
        await tx
          .update(schema.chatAgents)
          .set({ lastAssignedAt: new Date() })
          .where(
            and(
              eq(schema.chatAgents.businessId, tenant.businessId!),
              eq(schema.chatAgents.membershipId, target.id),
            ),
          );
        await this.audit(tx, tenant, 'chat.transfer', id, {
          from: row.assignedMembershipId,
          to: target.id,
        });
        return { saved: true };
      },
    );
  }
  async customerCandidates(tenant: RequestTenantContext, query: unknown) {
    const parsed = z
      .object({ q: z.string().trim().min(3).max(100) })
      .strict()
      .safeParse(query);
    if (!parsed.success) throw new BadRequestException('Enter at least three characters');
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        const manager = await this.manager(tx, tenant);
        if (!manager.effectivePermissions.has('customers.view'))
          throw new ForbiddenException('Customer read permission required');
        const search = '%' + parsed.data.q.replace(/[\\%_]/g, (char) => '\\' + char) + '%';
        return tx
          .select({
            id: schema.customers.id,
            firstName: schema.customers.firstName,
            lastName: schema.customers.lastName,
            number: schema.customers.customerNumber,
          })
          .from(schema.customers)
          .where(
            and(
              eq(schema.customers.businessId, tenant.businessId!),
              sql`concat_ws(' ', ${schema.customers.firstName}, ${schema.customers.lastName}, ${schema.customers.email}, ${schema.customers.phone}) ilike ${search}`,
            ),
          )
          .limit(10);
      },
    );
  }
  async linkCustomer(tenant: RequestTenantContext, id: string, body: unknown) {
    this.uuid(id);
    const parsed = chatLinkSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Confirm customer verification before linking');
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        const manager = await this.manager(tx, tenant);
        if (!manager.effectivePermissions.has('customers.view'))
          throw new ForbiddenException('Customer read permission required');
        const row = await this.staffConversation(tx, tenant, id);
        if (row.version !== parsed.data.version)
          throw new ConflictException('Conversation changed');
        if (parsed.data.customerId) {
          const [customer] = await tx
            .select()
            .from(schema.customers)
            .where(
              and(
                eq(schema.customers.businessId, tenant.businessId!),
                eq(schema.customers.id, parsed.data.customerId),
              ),
            );
          if (!customer) throw new NotFoundException('Customer not found');
        }
        await tx
          .update(conversations)
          .set({
            customerId: parsed.data.customerId,
            customerVerifiedAt: parsed.data.customerId ? new Date() : null,
            version: row.version + 1,
          })
          .where(and(eq(conversations.businessId, tenant.businessId!), eq(conversations.id, id)));
        await this.audit(tx, tenant, 'chat.customer_link', id, {
          linked: Boolean(parsed.data.customerId),
        });
        return { saved: true };
      },
    );
  }
  async report(tenant: RequestTenantContext) {
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        const member = await this.requireStaff(tx, tenant, 'chat.manage');
        const [summary] = await tx
          .select({
            total: sql<number>`count(*)::int`,
            active: sql<number>`count(*) filter(where ${conversations.status} not in ('resolved','spam'))::int`,
            resolved: sql<number>`count(*) filter(where ${conversations.status} = 'resolved')::int`,
            followups: sql<number>`count(*) filter(where ${conversations.followupRequestedAt} is not null and ${conversations.followupCompletedAt} is null)::int`,
            firstResponseSeconds: sql<
              number | null
            >`avg(extract(epoch from (${conversations.firstResponseAt} - ${conversations.createdAt})))`,
            resolutionSeconds: sql<
              number | null
            >`avg(extract(epoch from (${conversations.resolvedAt} - ${conversations.createdAt})))`,
            satisfaction: sql<number | null>`avg(${conversations.rating})`,
            linkedCustomers: sql<number>`count(${conversations.customerId})::int`,
          })
          .from(conversations)
          .where(and(eq(conversations.businessId, tenant.businessId!), this.scope(member)));
        const settings = await this.settingsIn(tx, tenant.businessId!);
        const [overdue] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(conversations)
          .where(
            and(
              eq(conversations.businessId, tenant.businessId!),
              this.scope(member),
              sql`${conversations.status} not in ('resolved','spam','snoozed') and ${conversations.awaitingSince} < now() - (${settings.config.responseMinutes} * interval '1 minute')`,
            ),
          );
        return {
          ...summary,
          overdue: overdue!.count,
          responseMinutes: settings.config.responseMinutes,
        };
      },
    );
  }
  async retention(tenant: RequestTenantContext, body?: unknown) {
    const parsed =
      body === undefined
        ? null
        : z
            .object({
              confirmation: z.literal('DELETE ELIGIBLE CHATS'),
              version: z.number().int().positive(),
            })
            .strict()
            .safeParse(body);
    if (parsed && !parsed.success)
      throw new BadRequestException('Explicit retention confirmation required');
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        await this.manager(tx, tenant);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenant.businessId!}))`);
        const settings = await this.settingsIn(tx, tenant.businessId!);
        if (parsed?.success && parsed.data.version !== settings.version)
          throw new ConflictException('Retention settings changed; preview again');
        if (!settings.config.retentionDays)
          return { eligible: 0, deleted: 0, version: settings.version, enabled: false };
        const filter = and(
          eq(conversations.businessId, tenant.businessId!),
          sql`${conversations.status} in ('resolved','spam') and (${conversations.followupRequestedAt} is null or ${conversations.followupCompletedAt} is not null) and ${conversations.updatedAt} < now() - (${settings.config.retentionDays} * interval '1 day')`,
        );
        const [count] = await tx
          .select({ value: sql<number>`count(*)::int` })
          .from(conversations)
          .where(filter);
        if (!parsed?.success)
          return { eligible: count!.value, version: settings.version, enabled: true };
        const deleted = await tx
          .delete(conversations)
          .where(filter)
          .returning({ id: conversations.id });
        await this.audit(tx, tenant, 'chat.retention', tenant.businessId!, {
          count: deleted.length,
        });
        return { deleted: deleted.length, version: settings.version, enabled: true };
      },
    );
  }
  async maintenance(businessId: string) {
    this.uuid(businessId);
    return withDrizzleTenantContext(this.db, { businessId }, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${businessId}))`);
      const { config } = await this.settingsIn(tx, businessId);
      const expired = await tx
        .update(conversations)
        .set({
          assignedMembershipId: null,
          assignedAt: null,
          acceptedAt: null,
          status: 'queued',
          version: sql`${conversations.version} + 1`,
        })
        .where(
          and(
            eq(conversations.businessId, businessId),
            sql`${conversations.status} = 'open' and ${conversations.assignedAt} < now() - (${config.acceptanceMinutes} * interval '1 minute') and ${conversations.acceptedAt} is null`,
          ),
        )
        .returning({ id: conversations.id });
      for (const row of expired)
        await tx.insert(schema.auditLogs).values({
          businessId,
          actorType: 'system',
          action: 'chat.assignment_expired',
          targetType: 'chat_conversation',
          targetId: row.id,
          changesJson: {},
        });
      await tx
        .update(conversations)
        .set({ status: 'queued', snoozedUntil: null, version: sql`${conversations.version} + 1` })
        .where(
          and(
            eq(conversations.businessId, businessId),
            eq(conversations.status, 'snoozed'),
            sql`${conversations.snoozedUntil} <= now()`,
          ),
        );
      if (!config.autoAssign || !withinChatHours(config))
        return { assigned: 0, expired: expired.length };
      const waiting = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.businessId, businessId),
            isNull(conversations.assignedMembershipId),
            sql`${conversations.status} in ('queued','open')`,
          ),
        )
        .orderBy(conversations.createdAt)
        .limit(100)
        .for('update');
      let assigned = 0;
      for (const row of waiting) {
        const target = (await this.eligibleAgents(tx, businessId, row.locationId)).find(
          (agent) => agent.available && agent.workload < agent.capacity,
        );
        if (!target) continue;
        await tx
          .update(conversations)
          .set({
            assignedMembershipId: target.id,
            assignedAt: new Date(),
            acceptedAt: null,
            status: 'open',
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(conversations.businessId, businessId), eq(conversations.id, row.id)));
        await tx
          .update(schema.chatAgents)
          .set({ lastAssignedAt: new Date() })
          .where(
            and(
              eq(schema.chatAgents.businessId, businessId),
              eq(schema.chatAgents.membershipId, target.id),
            ),
          );
        await tx.insert(schema.auditLogs).values({
          businessId,
          actorType: 'system',
          action: 'chat.auto_assign',
          targetType: 'chat_conversation',
          targetId: row.id,
          changesJson: { to: target.id },
        });
        assigned++;
      }
      return { assigned, expired: expired.length };
    });
  }

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
    if (!(await this.settingsIn(tx, businessId)).config.enabled)
      throw new ForbiddenException('Chat is disabled');
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

  async startConversation(
    auth: ChatVisitorAuth,
    clientConversationId: string,
    input: unknown,
    context?: unknown,
  ) {
    this.uuid(clientConversationId);
    const message = this.input(input);
    const parsedContext = context === undefined ? undefined : chatContextSchema.safeParse(context);
    if (parsedContext && !parsedContext.success)
      throw new BadRequestException('Invalid chat context');
    return this.visitor(auth, async (tx, session) => {
      if (parsedContext?.success && parsedContext.data.locationId) {
        const [location] = await tx
          .select()
          .from(schema.locations)
          .where(
            and(
              eq(schema.locations.businessId, session.businessId),
              eq(schema.locations.id, parsedContext.data.locationId),
            ),
          );
        if (!location) throw new BadRequestException('Unknown showroom');
      }
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
            contextJson: parsedContext?.success ? parsedContext.data : null,
            locationId: parsedContext?.success ? parsedContext.data.locationId : null,
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
            resolvedAt: new Date(),
            awaitingSince: null,
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
        const row = await this.staffConversation(tx, tenant, id);
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
      const { config } = await this.settingsIn(tx, session.businessId);
      const withinHours = withinChatHours(config);
      const agents = await this.eligibleAgents(tx, session.businessId, conversation.locationId);
      const available =
        withinHours &&
        agents.some(
          (agent) =>
            agent.available &&
            (agent.workload < agent.capacity || agent.id === conversation.assignedMembershipId),
        );
      const visible = rows.slice(0, limit);
      return {
        data: visible.map((row) => this.publicMessage(row)),
        activity: {
          teamAvailable: Boolean(available),
          availability: !withinHours ? 'outside_hours' : available ? 'available' : 'busy',
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

  /** Every staff read/write rechecks role, assignment and location scope. */
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
      (!tenant.permissions.has('chat.view_team') &&
        !tenant.permissions.has('chat.view_assigned')) ||
      !tenant.permissions.has('chat.reply')
    )
      throw new ForbiddenException('Chat team reply permission required');
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        const member = await this.requireStaff(tx, tenant, true);
        const conversation = await this.staffConversation(tx, tenant, conversationId);
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
      .extend({ clientConversationId: z.string().uuid(), context: chatContextSchema.optional() })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid conversation request');
    const { clientConversationId, context, ...message } = parsed.data;
    return this.startConversation(auth, clientConversationId, message, context);
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
      (!tenant.permissions.has('chat.view_team') && !tenant.permissions.has('chat.view_assigned'))
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
        ),
      )
      .for('share');
    if (!member) throw new ForbiddenException('Active chat membership required');
    if (member.dataScope !== tenant.dataScope)
      throw new ForbiddenException('Chat scope permission required');
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
      (!effective.has('chat.view_team') && !effective.has('chat.view_assigned')) ||
      (reply && !effective.has(reply === true ? 'chat.reply' : reply))
    )
      throw new ForbiddenException('Chat team reply permission required');

    const locations = await tx
      .select({ id: schema.membershipLocationScopes.locationId })
      .from(schema.membershipLocationScopes)
      .where(
        and(
          eq(schema.membershipLocationScopes.businessId, tenant.businessId!),
          eq(schema.membershipLocationScopes.membershipId, member.id),
        ),
      );
    return {
      ...member,
      effectivePermissions: effective,
      canViewTeam: effective.has('chat.view_team'),
      scopeLocations: locations.map((row) => row.id),
    };
  }
  private scope(member: {
    id: string;
    dataScope: string;
    canViewTeam: boolean;
    scopeLocations: string[];
  }) {
    return and(
      member.canViewTeam ? undefined : eq(conversations.assignedMembershipId, member.id),
      member.dataScope === 'all'
        ? undefined
        : member.dataScope === 'store' && member.scopeLocations.length
          ? inArray(conversations.locationId, member.scopeLocations)
          : sql`false`,
    );
  }
  private async staffConversation(
    tx: DrizzleTransaction,
    tenant: RequestTenantContext,
    id: string,
  ) {
    const member = await this.requireStaff(tx, tenant);
    const [row] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.businessId, tenant.businessId!),
          eq(conversations.id, id),
          this.scope(member),
        ),
      )
      .for('update');
    if (!row) throw new NotFoundException('Conversation not found');
    return row;
  }

  /** Metadata only; each snapshot rechecks membership and runs under tenant RLS. */
  async staffLiveSnapshot(tenant: RequestTenantContext) {
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => {
        const access = await this.requireStaff(tx, tenant);
        const { config } = await this.settingsIn(tx, tenant.businessId!);
        await tx
          .update(conversations)
          .set({ status: 'open', snoozedUntil: null, version: sql`${conversations.version} + 1` })
          .where(
            and(
              eq(conversations.businessId, tenant.businessId!),
              this.scope(access),
              eq(conversations.status, 'snoozed'),
              sql`${conversations.snoozedUntil} <= now()`,
            ),
          );
        return tx
          .select({
            id: conversations.id,
            version: conversations.version,
            overdue: sql<boolean>`coalesce(${conversations.status} not in ('resolved','spam','snoozed') and ${conversations.awaitingSince} < now() - (${config.responseMinutes} * interval '1 minute'), false)`,
            locationId: conversations.locationId,
            acceptedAt: conversations.acceptedAt,
            assignedAt: conversations.assignedAt,
            awaitingSince: conversations.awaitingSince,
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
          .where(and(eq(conversations.businessId, tenant.businessId!), this.scope(access)));
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
        const access = await this.requireStaff(tx, tenant);
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
              this.scope(access),
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
        await this.manager(tx, tenant);
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
        await this.manager(tx, tenant);
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
        return update(tx, await this.staffConversation(tx, tenant!, id), true);
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
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenant.businessId!}))`);
        const row = await this.staffConversation(tx, tenant, id);
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
          await this.manager(tx, tenant);
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
              ? {
                  assignedMembershipId: tenant.membershipId,
                  assignedAt: new Date(),
                  acceptedAt: new Date(),
                  status: 'open',
                }
              : {}),
            ...(action === 'release' ? { assignedMembershipId: null, status: 'queued' } : {}),
            ...(action === 'resolve'
              ? { status: 'resolved', resolvedAt: new Date(), awaitingSince: null }
              : {}),
            ...(action === 'spam' ? { status: 'spam' } : {}),
            ...(action === 'reopen'
              ? { status: row.assignedMembershipId ? 'open' : 'queued', resolvedAt: null }
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
        await this.staffConversation(tx, tenant, id);
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
        await this.staffConversation(tx, tenant, conversationId);
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
        ...(actor.type === 'staff' && actor.audience === 'public'
          ? {
              firstResponseAt: conversation.firstResponseAt ?? new Date(),
              awaitingSince: null,
              acceptedAt:
                conversation.assignedMembershipId === actor.id
                  ? new Date()
                  : conversation.acceptedAt,
            }
          : {}),
        ...(actor.type === 'visitor'
          ? { awaitingSince: conversation.awaitingSince ?? new Date(), resolvedAt: null }
          : {}),
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
