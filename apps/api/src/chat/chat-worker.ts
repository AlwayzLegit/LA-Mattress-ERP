import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema, withDrizzleTenantContext } from '@jetnine/db';

export interface ChatChange {
  id: string;
  businessId: string;
  conversationId: string;
  sequence: number;
  audience: 'visitor' | 'staff';
}
export interface ChatPublisher {
  publish(event: ChatChange): Promise<void>;
}
const {
  chatOutbox: outbox,
  chatConversations: conversations,
  chatSessions: sessions,
  chatIntegrations: integrations,
} = schema;

/** Lease/commit before network I/O; abandoned leases can be reclaimed. */
export class ChatWorker {
  private readonly logger = new Logger(ChatWorker.name);
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly publisher: ChatPublisher,
    private readonly environment: 'staging' | 'production',
    private readonly now = () => new Date(),
  ) {}
  async claim(businessId: string) {
    return withDrizzleTenantContext(this.db, { businessId }, async (tx) => {
      const now = this.now();
      const [row] = await tx
        .select({ event: outbox })
        .from(outbox)
        .innerJoin(
          conversations,
          and(
            eq(conversations.id, outbox.conversationId),
            eq(conversations.businessId, outbox.businessId),
          ),
        )
        .innerJoin(
          sessions,
          and(eq(sessions.id, conversations.sessionId), eq(sessions.businessId, businessId)),
        )
        .innerJoin(
          integrations,
          and(eq(integrations.id, sessions.integrationId), eq(integrations.businessId, businessId)),
        )
        .where(
          and(
            eq(outbox.businessId, businessId),
            isNull(outbox.completedAt),
            isNull(outbox.failedAt),
            lte(outbox.availableAt, now),
            or(isNull(outbox.leaseExpiresAt), lte(outbox.leaseExpiresAt, now)),
            eq(integrations.environment, this.environment),
            eq(integrations.enabled, true),
          ),
        )
        .orderBy(outbox.availableAt, outbox.id)
        .limit(1)
        .for('update', { of: outbox, skipLocked: true });
      if (!row) return null;
      const [leased] = await tx
        .update(outbox)
        .set({
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(now.getTime() + 30000),
          attempts: sql`${outbox.attempts} + 1`,
        })
        .where(eq(outbox.id, row.event.id))
        .returning();
      return leased!;
    });
  }
  async settle(event: typeof outbox.$inferSelect, success: boolean) {
    const now = this.now();
    return withDrizzleTenantContext(this.db, { businessId: event.businessId }, async (tx) => {
      const result = await tx
        .update(outbox)
        .set({
          leaseToken: null,
          leaseExpiresAt: null,
          ...(success
            ? { completedAt: now }
            : event.attempts >= 8
              ? { failedAt: now }
              : {
                  availableAt: new Date(
                    now.getTime() + Math.min(60000, 1000 * 2 ** (event.attempts - 1)),
                  ),
                }),
        })
        .where(
          and(
            eq(outbox.businessId, event.businessId),
            eq(outbox.id, event.id),
            eq(outbox.leaseToken, event.leaseToken!),
            isNull(outbox.completedAt),
          ),
        )
        .returning({ id: outbox.id });
      return result.length === 1;
    });
  }
  async runOnce(businessId: string) {
    const event = await this.claim(businessId);
    if (!event) return false;
    try {
      await this.publisher.publish({
        id: event.id,
        businessId: event.businessId,
        conversationId: event.conversationId,
        sequence: event.sequence,
        audience: event.audience as ChatChange['audience'],
      });
    } catch (error) {
      await this.settle(event, false);
      // Provider bodies and network errors can contain credentials or message data.
      // Log only numeric provider diagnostics and our own delivery identifiers.
      const diagnostic = {
        event: 'chat_delivery_failed',
        eventId: event.id,
        attempts: event.attempts,
        exhausted: event.attempts >= 8,
        ...(error instanceof ChatDeliveryError
          ? { providerStatus: error.status, providerCode: error.code }
          : { reason: 'network_or_provider_failure' }),
      };
      if (event.attempts >= 8) this.logger.error(diagnostic);
      else this.logger.warn(diagnostic);
      return true;
    }
    await this.settle(event, true);
    return true;
  }
}

export class ChatDeliveryError extends Error {
  constructor(
    readonly status: number,
    readonly code?: number,
  ) {
    super('Chat event delivery failed');
    this.name = 'ChatDeliveryError';
  }
}

export class AblyChatPublisher implements ChatPublisher {
  constructor(
    private readonly key: string,
    private readonly environment: 'staging' | 'production',
    private readonly request: typeof fetch = fetch,
  ) {
    if (!key.includes(':')) throw new Error('ABLY_API_KEY is required');
  }
  async publish(event: ChatChange) {
    const channel = `chat:${this.environment}:${event.businessId}:${event.conversationId}:${event.audience}`;
    const response = await this.request(
      `https://main.realtime.ably.net/channels/${encodeURIComponent(channel)}/messages`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Basic ${Buffer.from(this.key).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: event.id,
          name: 'conversation.changed',
          data: { conversationId: event.conversationId, sequence: event.sequence },
        }),
      },
    );
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const providerCode = (body as { error?: { code?: unknown } } | null)?.error?.code;
      throw new ChatDeliveryError(
        response.status,
        typeof providerCode === 'number' && Number.isFinite(providerCode)
          ? providerCode
          : undefined,
      );
    }
  }
}
