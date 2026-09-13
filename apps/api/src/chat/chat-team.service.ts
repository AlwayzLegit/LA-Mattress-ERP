import { queueInternalPush } from './chat-internal-push';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema, withDrizzleTenantContext, type DrizzleTransaction } from '@jetnine/db';
import {
  chatTeamRoomSchema,
  chatTeamMessageSchema,
  chatTeamActionSchema,
  chatTeamHistorySchema,
  chatHelpActivitySchema,
} from '@jetnine/shared';
import { z } from 'zod';
import type { RequestTenantContext } from '../tenancy/request-context';

type Member = {
  id: string;
  dataScope: string;
  scopeLocations: string[];
  effectivePermissions: Set<string>;
};
type Room = typeof schema.chatTeamRooms.$inferSelect;
const r = schema.chatTeamRooms,
  m = schema.chatTeamMessages,
  a = schema.chatTeamActivity;

/** Internal collaboration only. No visitor channels, customer records, or public message publisher. */
export class ChatTeamService {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly authorize: (
      tx: DrizzleTransaction,
      tenant: RequestTenantContext,
    ) => Promise<Member>,
    private readonly environment: string,
  ) {}
  private uuid(id: string) {
    if (!z.string().uuid().safeParse(id).success)
      throw new BadRequestException('Invalid team identifier');
  }
  private run<T>(
    tenant: RequestTenantContext,
    fn: (tx: DrizzleTransaction, member: Member) => Promise<T>,
  ) {
    return withDrizzleTenantContext(
      this.db,
      { businessId: tenant.businessId, userId: tenant.userId },
      async (tx) => fn(tx, await this.authorize(tx, tenant)),
    );
  }
  private async people(tx: DrizzleTransaction, businessId: string) {
    const rows = await tx
      .select({ member: schema.memberships, name: schema.users.name, agent: schema.chatAgents })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .leftJoin(
        schema.chatAgents,
        and(
          eq(schema.chatAgents.businessId, businessId),
          eq(schema.chatAgents.membershipId, schema.memberships.id),
        ),
      )
      .where(
        and(eq(schema.memberships.businessId, businessId), eq(schema.memberships.status, 'active')),
      );
    if (!rows.length) return [];
    const permissions = await tx
      .select()
      .from(schema.rolePermissions)
      .where(
        inArray(
          schema.rolePermissions.roleId,
          rows.map((row) => row.member.roleId),
        ),
      );
    const overrides = await tx
      .select()
      .from(schema.membershipPermissionOverrides)
      .where(eq(schema.membershipPermissionOverrides.businessId, businessId));
    const scopes = await tx
      .select()
      .from(schema.membershipLocationScopes)
      .where(eq(schema.membershipLocationScopes.businessId, businessId));
    return rows.flatMap((row) => {
      const effective = new Set(
        permissions.filter((p) => p.roleId === row.member.roleId).map((p) => p.permission),
      );
      for (const p of overrides.filter((p) => p.membershipId === row.member.id)) {
        if (p.allowed) effective.add(p.permission);
        else effective.delete(p.permission);
      }
      if (
        !effective.has('chat.reply') ||
        (!effective.has('chat.view_team') && !effective.has('chat.view_assigned'))
      )
        return [];
      return [
        {
          id: row.member.id,
          name: row.name || 'Specialist',
          dataScope: row.member.dataScope,
          scopeLocations: scopes
            .filter((s) => s.membershipId === row.member.id)
            .map((s) => s.locationId),
          available: Boolean(
            row.agent?.available &&
            row.agent.heartbeatUntil &&
            row.agent.heartbeatUntil > new Date(),
          ),
        },
      ];
    });
  }
  private allowed(room: Room, member: Pick<Member, 'id' | 'dataScope' | 'scopeLocations'>) {
    return (
      room.kind === 'helpdesk' ||
      (room.kind === 'direct' && [room.memberA, room.memberB].includes(member.id)) ||
      (room.kind === 'store' &&
        (member.dataScope === 'all' ||
          (member.dataScope === 'store' && member.scopeLocations.includes(room.locationId!))))
    );
  }
  private async room(
    tx: DrizzleTransaction,
    tenant: RequestTenantContext,
    member: Member,
    id: string,
  ) {
    this.uuid(id);
    const [room] = await tx
      .select()
      .from(r)
      .where(and(eq(r.businessId, tenant.businessId!), eq(r.id, id)));
    if (!room || !this.allowed(room, member))
      throw new NotFoundException('Team conversation not found');
    if (room.kind === 'store') {
      const [location] = await tx
        .select()
        .from(schema.locations)
        .where(
          and(
            eq(schema.locations.businessId, tenant.businessId!),
            eq(schema.locations.id, room.locationId!),
            eq(schema.locations.isActive, true),
          ),
        );
      if (!location) throw new NotFoundException('Store channel unavailable');
    }
    return room;
  }
  private async audit(
    tx: DrizzleTransaction,
    tenant: RequestTenantContext,
    action: string,
    roomId: string,
    details: Record<string, unknown> = {},
  ) {
    await tx.insert(schema.auditLogs).values({
      businessId: tenant.businessId!,
      actorUserId: tenant.userId!,
      actorType: 'user',
      action: 'chat.team.' + action,
      targetType: 'chat_team_room',
      targetId: roomId,
      changesJson: details,
    });
  }
  async directory(tenant: RequestTenantContext) {
    return this.run(tenant, async (tx, member) => {
      const people = await this.people(tx, tenant.businessId!);
      const locations = (
        await tx
          .select({ id: schema.locations.id, name: schema.locations.name })
          .from(schema.locations)
          .where(
            and(
              eq(schema.locations.businessId, tenant.businessId!),
              eq(schema.locations.isActive, true),
              eq(schema.locations.locationType, 'store'),
            ),
          )
      ).filter(
        (l) =>
          member.dataScope === 'all' ||
          (member.dataScope === 'store' && member.scopeLocations.includes(l.id)),
      );
      const rooms = (
        await tx
          .select()
          .from(r)
          .where(eq(r.businessId, tenant.businessId!))
          .orderBy(sql`${r.updatedAt} desc`)
      ).filter(
        (room) =>
          this.allowed(room, member) &&
          (room.kind !== 'store' || locations.some((l) => l.id === room.locationId)),
      );
      if (!rooms.length)
        return {
          rooms: [],
          people: people.map(({ id, name, available }) => ({ id, name, available })),
          locations,
          membershipId: member.id,
        };
      const activity = await tx
        .select()
        .from(a)
        .where(
          and(
            eq(a.businessId, tenant.businessId!),
            eq(a.membershipId, member.id),
            inArray(
              a.roomId,
              rooms.map((row) => row.id),
            ),
          ),
        );
      const counts = await tx
        .select({
          roomId: m.roomId,
          unreadSequence:
            sql<number>`coalesce(max(${m.sequence}) filter (where ${m.senderId} <> ${member.id} and ${m.sequence} > coalesce(${a.readSequence},0)),0)`.mapWith(
              Number,
            ),
          unread:
            sql<number>`count(*) filter (where ${m.senderId} <> ${member.id} and ${m.sequence} > coalesce(${a.readSequence},0))`.mapWith(
              Number,
            ),
          mentioned:
            sql<number>`count(*) filter (where ${m.mentionId} = ${member.id} and ${m.sequence} > coalesce(${a.readSequence},0))`.mapWith(
              Number,
            ),
          open: sql<number>`count(*) filter (where ${m.question} and ${m.status} <> 'resolved')`.mapWith(
            Number,
          ),
          urgent:
            sql<number>`count(*) filter (where ${m.question} and ${m.urgent} and ${m.status} <> 'resolved')`.mapWith(
              Number,
            ),
        })
        .from(m)
        .leftJoin(
          a,
          and(
            eq(a.businessId, m.businessId),
            eq(a.roomId, m.roomId),
            eq(a.membershipId, member.id),
          ),
        )
        .where(
          and(
            eq(m.businessId, tenant.businessId!),
            inArray(
              m.roomId,
              rooms.map((row) => row.id),
            ),
          ),
        )
        .groupBy(m.roomId);
      return {
        membershipId: member.id,
        people: people.map(({ id, name, available }) => ({ id, name, available })),
        locations,
        rooms: rooms.map((room) => ({
          ...room,
          title:
            room.kind === 'helpdesk'
              ? 'Team help desk'
              : room.kind === 'store'
                ? (locations.find((l) => l.id === room.locationId)?.name ?? 'Store')
                : (people.find(
                    (p) => p.id === (room.memberA === member.id ? room.memberB : room.memberA),
                  )?.name ?? 'Former teammate'),
          readSequence: activity.find((p) => p.roomId === room.id)?.readSequence ?? 0,
          ...(counts.find((c) => c.roomId === room.id) ?? {
            unreadSequence: 0,
            unread: 0,
            mentioned: 0,
            open: 0,
            urgent: 0,
          }),
        })),
      };
    });
  }
  async open(tenant: RequestTenantContext, body: unknown) {
    const parsed = chatTeamRoomSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Choose a team conversation');
    return this.run(tenant, async (tx, member) => {
      const input = parsed.data;
      let locationId: string | null = null,
        memberA: string | null = null,
        memberB: string | null = null,
        key: string = input.kind;
      if (input.kind === 'store') {
        const [location] = await tx
          .select()
          .from(schema.locations)
          .where(
            and(
              eq(schema.locations.businessId, tenant.businessId!),
              eq(schema.locations.id, input.locationId),
              eq(schema.locations.isActive, true),
              eq(schema.locations.locationType, 'store'),
            ),
          );
        if (
          !location ||
          (member.dataScope !== 'all' &&
            !(member.dataScope === 'store' && member.scopeLocations.includes(input.locationId)))
        )
          throw new ForbiddenException('Store channel access required');
        locationId = input.locationId;
        key += ':' + locationId;
      }
      if (input.kind === 'direct') {
        if (
          input.memberId === member.id ||
          !(await this.people(tx, tenant.businessId!)).some((p) => p.id === input.memberId)
        )
          throw new BadRequestException('Choose an active chat teammate');
        const pair = [member.id, input.memberId].sort();
        memberA = pair[0]!;
        memberB = pair[1]!;
        key += ':' + memberA + ':' + memberB;
      }
      const [created] = await tx
        .insert(r)
        .values({
          businessId: tenant.businessId!,
          kind: input.kind,
          key,
          locationId,
          memberA,
          memberB,
        })
        .onConflictDoNothing({ target: [r.businessId, r.key] })
        .returning();
      const room =
        created ??
        (
          await tx
            .select()
            .from(r)
            .where(and(eq(r.businessId, tenant.businessId!), eq(r.key, key)))
        )[0]!;
      if (created) await this.audit(tx, tenant, 'room_created', room.id, { kind: room.kind });
      return { id: room.id };
    });
  }
  async history(tenant: RequestTenantContext, id: string, query: unknown) {
    const parsed = chatTeamHistorySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Invalid team history filter');
    return this.run(tenant, async (tx, member) => {
      const room = await this.room(tx, tenant, member, id);
      const people = (await this.people(tx, tenant.businessId!)).filter((p) =>
        this.allowed(room, p),
      );
      const filter = parsed.data.filter;
      const rows = await tx
        .select()
        .from(m)
        .where(
          and(
            eq(m.businessId, tenant.businessId!),
            eq(m.roomId, id),
            lt(m.sequence, parsed.data.beforeSequence ?? room.lastSequence + 1),
            filter === 'open'
              ? and(eq(m.question, true), sql`${m.status} <> 'resolved'`)
              : filter === 'saved'
                ? eq(m.saved, true)
                : undefined,
          ),
        )
        .orderBy(sql`${m.sequence} desc`)
        .limit(101);
      const data = rows
        .slice(0, 100)
        .reverse()
        .map((row) => ({
          ...row,
          mine: row.senderId === member.id,
          senderName: people.find((p) => p.id === row.senderId)?.name ?? 'Former teammate',
          assignedName: people.find((p) => p.id === row.assignedId)?.name ?? null,
        }));
      const typing = await tx
        .select()
        .from(a)
        .where(
          and(
            eq(a.businessId, tenant.businessId!),
            eq(a.roomId, id),
            sql`${a.typingUntil}>now()`,
            sql`${a.membershipId}<>${member.id}`,
          ),
        );
      return {
        data,
        hasMore: rows.length > 100,
        nextBefore: data[0]?.sequence,
        room,
        people: people.map(({ id, name, available }) => ({ id, name, available })),
        typing: typing.flatMap((t) => people.find((p) => p.id === t.membershipId)?.name ?? []),
        canManage: member.effectivePermissions.has('chat.manage'),
        membershipId: member.id,
      };
    });
  }
  async send(tenant: RequestTenantContext, id: string, body: unknown) {
    const parsed = chatTeamMessageSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Write a team message of up to 4,000 characters');
    return this.run(tenant, async (tx, member) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenant.businessId!}))`);
      const room = await this.room(tx, tenant, member, id),
        input = parsed.data;
      const people = (await this.people(tx, tenant.businessId!)).filter((p) =>
        this.allowed(room, p),
      );
      if (room.kind === 'direct' && people.length !== 2)
        throw new ConflictException('This teammate no longer has chat access');
      if (
        input.mentionId &&
        (input.mentionId === member.id || !people.some((p) => p.id === input.mentionId))
      )
        throw new BadRequestException('Mention someone in this conversation');
      if (
        (input.question && (room.kind !== 'helpdesk' || input.replyToId)) ||
        (input.urgent && !input.question)
      )
        throw new BadRequestException('Help questions belong in the team help desk');
      if (input.replyToId) {
        const [parent] = await tx
          .select()
          .from(m)
          .where(
            and(eq(m.businessId, tenant.businessId!), eq(m.roomId, id), eq(m.id, input.replyToId)),
          );
        if (!parent) throw new NotFoundException('Reply target not found');
      }
      const [existing] = await tx
        .select()
        .from(m)
        .where(and(eq(m.businessId, tenant.businessId!), eq(m.id, input.id)));
      if (existing) {
        if (
          existing.roomId !== id ||
          existing.senderId !== member.id ||
          existing.body !== input.body ||
          existing.question !== input.question ||
          existing.urgent !== input.urgent ||
          existing.mentionId !== (input.mentionId ?? null) ||
          existing.replyToId !== (input.replyToId ?? null)
        )
          throw new ConflictException('Message retry does not match');
        return existing;
      }
      const [message] = await tx
        .insert(m)
        .values({
          ...input,
          businessId: tenant.businessId!,
          roomId: id,
          senderId: member.id,
          sequence: room.lastSequence + 1,
        })
        .returning();
      await tx
        .update(r)
        .set({
          lastSequence: room.lastSequence + 1,
          revision: room.revision + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(r.businessId, tenant.businessId!), eq(r.id, id)));
      await tx
        .update(a)
        .set({ typingUntil: null })
        .where(
          and(
            eq(a.businessId, tenant.businessId!),
            eq(a.roomId, id),
            eq(a.membershipId, member.id),
          ),
        );
      await queueInternalPush(
        tx,
        tenant.businessId!,
        this.environment,
        people.filter((p) => p.id !== member.id).map((p) => p.id),
        { kind: 'team_message', teamRoomId: id, sequence: message!.sequence },
      );
      await this.audit(tx, tenant, 'message', id, {
        messageId: message!.id,
        question: input.question,
        urgent: input.urgent,
      });
      return message;
    });
  }
  async action(tenant: RequestTenantContext, id: string, messageId: string, body: unknown) {
    this.uuid(messageId);
    const parsed = chatTeamActionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid team action');
    return this.run(tenant, async (tx, member) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenant.businessId!}))`);
      const room = await this.room(tx, tenant, member, id);
      const [message] = await tx
        .select()
        .from(m)
        .where(and(eq(m.businessId, tenant.businessId!), eq(m.roomId, id), eq(m.id, messageId)))
        .for('update');
      if (!message) throw new NotFoundException('Team message not found');
      if (message.version !== parsed.data.version)
        throw new ConflictException('This question or answer changed. Review the latest state.');
      const action = parsed.data.action,
        manager = member.effectivePermissions.has('chat.manage'),
        mine = message.senderId === member.id,
        assigned = message.assignedId === member.id;
      const change: Partial<typeof m.$inferInsert> = { version: message.version + 1 };
      if (action === 'save' || action === 'unsave') {
        if (!mine && !manager)
          throw new ForbiddenException('Only the author or a chat manager can save this answer');
        change.saved = action === 'save';
      } else {
        if (!message.question || room.kind !== 'helpdesk')
          throw new BadRequestException('Choose a help desk question');
        if (action === 'claim') {
          if (message.status !== 'open')
            throw new ConflictException('Someone already picked up this question');
          change.status = 'claimed';
          change.assignedId = member.id;
        }
        if (action === 'release') {
          if (message.status !== 'claimed' || (!assigned && !manager))
            throw new ForbiddenException(
              'Only the helping specialist or manager can release this question',
            );
          change.status = 'open';
          change.assignedId = null;
        }
        if (action === 'resolve') {
          if (message.status === 'resolved' || (!mine && !assigned && !manager))
            throw new ForbiddenException(
              'Only the requester, helping specialist or manager can resolve this question',
            );
          change.status = 'resolved';
        }
        if (action === 'reopen') {
          if (message.status !== 'resolved' || (!mine && !manager))
            throw new ForbiddenException('Only the requester or manager can reopen this question');
          change.status = 'open';
          change.assignedId = null;
        }
      }
      const [updated] = await tx
        .update(m)
        .set(change)
        .where(and(eq(m.businessId, tenant.businessId!), eq(m.id, messageId)))
        .returning();
      await tx
        .update(r)
        .set({ revision: room.revision + 1, updatedAt: new Date() })
        .where(and(eq(r.businessId, tenant.businessId!), eq(r.id, id)));
      await this.audit(tx, tenant, action, id, { messageId });
      return updated;
    });
  }
  async activity(tenant: RequestTenantContext, id: string, body: unknown) {
    const parsed = chatHelpActivitySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid team activity');
    return this.run(tenant, async (tx, member) => {
      const room = await this.room(tx, tenant, member, id);
      const read = Math.min(parsed.data.readSequence ?? 0, room.lastSequence);
      const typing = parsed.data.typing ? new Date(Date.now() + 6000) : null;
      await tx
        .insert(a)
        .values({
          businessId: tenant.businessId!,
          roomId: id,
          membershipId: member.id,
          readSequence: read,
          typingUntil: typing,
        })
        .onConflictDoUpdate({
          target: [a.businessId, a.roomId, a.membershipId],
          set: {
            readSequence: sql`greatest(${a.readSequence},${read})`,
            ...(parsed.data.typing !== undefined ? { typingUntil: typing } : {}),
          },
        });
      return { ok: true };
    });
  }
}
