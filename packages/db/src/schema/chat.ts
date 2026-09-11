import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { businesses } from './platform';

const businessId = () =>
  uuid('business_id')
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const chatIntegrations = pgTable(
  'chat_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessId(),
    credentialHash: text('credential_hash').notNull(),
    allowedOrigin: text('allowed_origin').notNull(),
    environment: text('environment').notNull().default('staging'),
    enabled: boolean('enabled').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => ({
    tenantId: uniqueIndex('chat_integrations_tenant_id').on(t.businessId, t.id),
    environmentCheck: check(
      'chat_integrations_environment_check',
      sql`${t.environment} in ('staging', 'production')`,
    ),
  }),
);

export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessId(),
    integrationId: uuid('integration_id').notNull(),
    credentialHash: text('credential_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    tenantId: uniqueIndex('chat_sessions_tenant_id').on(t.businessId, t.id),
    credential: uniqueIndex('chat_sessions_credential_uniq').on(t.credentialHash),
    integrationIdx: index('chat_sessions_integration_idx').on(t.businessId, t.integrationId),
    integrationFk: foreignKey({
      columns: [t.businessId, t.integrationId],
      foreignColumns: [chatIntegrations.businessId, chatIntegrations.id],
    }).onDelete('cascade'),
  }),
);

export const chatConversations = pgTable(
  'chat_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessId(),
    sessionId: uuid('session_id').notNull(),
    // A stable client ID makes a lost create acknowledgement safe to retry.
    clientConversationId: uuid('client_conversation_id').notNull(),
    status: text('status').notNull().default('queued'),
    lastSequence: integer('last_sequence').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantId: uniqueIndex('chat_conversations_tenant_id').on(t.businessId, t.id),
    createKey: uniqueIndex('chat_conversations_create_key').on(
      t.businessId,
      t.sessionId,
      t.clientConversationId,
    ),
    queueIdx: index('chat_conversations_queue_idx').on(t.businessId, t.status, t.updatedAt),
    sessionFk: foreignKey({
      columns: [t.businessId, t.sessionId],
      foreignColumns: [chatSessions.businessId, chatSessions.id],
    }).onDelete('cascade'),
    statusCheck: check(
      'chat_conversations_status_check',
      sql`${t.status} in ('queued', 'open', 'waiting_customer', 'snoozed', 'resolved', 'spam')`,
    ),
    sequenceCheck: check(
      'chat_conversations_sequence_check',
      sql`${t.lastSequence} >= 0 and ${t.version} > 0`,
    ),
  }),
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessId(),
    conversationId: uuid('conversation_id').notNull(),
    senderType: text('sender_type').notNull(),
    // Immutable identity retained if a staff membership is later removed.
    senderId: uuid('sender_id').notNull(),
    audience: text('audience').notNull(),
    body: text('body').notNull(),
    fingerprint: text('fingerprint').notNull(),
    clientMessageId: uuid('client_message_id').notNull(),
    sequence: integer('sequence').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    historyIdx: uniqueIndex('chat_messages_sequence_uniq').on(
      t.businessId,
      t.conversationId,
      t.sequence,
    ),
    dedupeIdx: uniqueIndex('chat_messages_client_key').on(
      t.businessId,
      t.conversationId,
      t.senderType,
      t.senderId,
      t.clientMessageId,
    ),
    conversationFk: foreignKey({
      columns: [t.businessId, t.conversationId],
      foreignColumns: [chatConversations.businessId, chatConversations.id],
    }).onDelete('cascade'),
    senderCheck: check('chat_messages_sender_check', sql`${t.senderType} in ('visitor', 'staff')`),
    audienceCheck: check(
      'chat_messages_audience_check',
      sql`${t.audience} in ('public', 'internal') and (${t.senderType} <> 'visitor' or ${t.audience} = 'public')`,
    ),
    bodyCheck: check('chat_messages_body_check', sql`length(btrim(${t.body})) between 1 and 4000`),
    sequenceCheck: check('chat_messages_sequence_check', sql`${t.sequence} > 0`),
  }),
);

// Contains change metadata only: never message text, contacts or credentials.
export const chatOutbox = pgTable(
  'chat_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessId(),
    conversationId: uuid('conversation_id').notNull(),
    audience: text('audience').notNull(),
    sequence: integer('sequence').notNull(),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    dueIdx: index('chat_outbox_due_idx').on(t.businessId, t.completedAt, t.failedAt, t.availableAt),
    eventKey: uniqueIndex('chat_outbox_event_key').on(
      t.businessId,
      t.conversationId,
      t.sequence,
      t.audience,
    ),
    conversationFk: foreignKey({
      columns: [t.businessId, t.conversationId],
      foreignColumns: [chatConversations.businessId, chatConversations.id],
    }).onDelete('cascade'),
    audienceCheck: check('chat_outbox_audience_check', sql`${t.audience} in ('visitor', 'staff')`),
    countCheck: check('chat_outbox_count_check', sql`${t.sequence} > 0 and ${t.attempts} >= 0`),
    leaseCheck: check(
      'chat_outbox_lease_check',
      sql`(${t.leaseToken} is null) = (${t.leaseExpiresAt} is null)`,
    ),
  }),
);
