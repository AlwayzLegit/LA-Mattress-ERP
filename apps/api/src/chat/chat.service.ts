import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema, withDrizzleTenantContext, type DrizzleTransaction } from '@jetnine/db';
import {
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

/** Persistence foundation only. No HTTP routes are registered until adapter,
 * shared rate limiting and staging isolation are implemented. Pass the root DB;
 * each operation owns its RLS transaction and resolves only after commit. */
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
      await this.conversation(tx, session.businessId, conversationId, session.id);
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
      const visible = rows.slice(0, limit);
      return {
        data: visible.map((row) => this.publicMessage(row)),
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
        if (!effective.has('chat.view_team') || !effective.has('chat.reply'))
          throw new ForbiddenException('Chat team reply permission required');
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
