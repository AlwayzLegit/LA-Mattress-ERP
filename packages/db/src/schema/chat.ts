import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
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
    assignedMembershipId: uuid('assigned_membership_id'),
    locationId: uuid('location_id'),
    contextJson: jsonb('context_json'),
    customerId: uuid('customer_id'),
    customerVerifiedAt: timestamp('customer_verified_at', { withTimezone: true }),
    firstResponseAt: timestamp('first_response_at', { withTimezone: true }),
    awaitingSince: timestamp('awaiting_since', { withTimezone: true }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    rating: integer('rating'),
    followupName: text('followup_name'),
    followupMethod: text('followup_method'),
    followupContact: text('followup_contact'),
    followupRequestedAt: timestamp('followup_requested_at', { withTimezone: true }),
    followupCompletedAt: timestamp('followup_completed_at', { withTimezone: true }),
    visitorReadSequence: integer('visitor_read_sequence').notNull().default(0),
    staffReadSequence: integer('staff_read_sequence').notNull().default(0),
    visitorTypingUntil: timestamp('visitor_typing_until', { withTimezone: true }),
    staffTypingUntil: timestamp('staff_typing_until', { withTimezone: true }),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
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

export const chatPushSubscriptions = pgTable(
  'chat_push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessId(),
    userId: uuid('user_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    environment: text('environment').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    tenantId: uniqueIndex('chat_push_subscriptions_tenant_id').on(t.businessId, t.id),
    endpointKey: uniqueIndex('chat_push_subscriptions_endpoint').on(t.businessId, t.endpoint),
  }),
);
export const chatPushDeliveries = pgTable(
  'chat_push_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessId(),
    subscriptionId: uuid('subscription_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    sequence: integer('sequence').notNull(),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
  },
  (t) => ({
    eventKey: uniqueIndex('chat_push_deliveries_event').on(
      t.subscriptionId,
      t.conversationId,
      t.sequence,
    ),
    due: index('chat_push_deliveries_due').on(t.businessId, t.availableAt),
    subscriptionFk: foreignKey({
      columns: [t.businessId, t.subscriptionId],
      foreignColumns: [chatPushSubscriptions.businessId, chatPushSubscriptions.id],
    }).onDelete('cascade'),
    conversationFk: foreignKey({
      columns: [t.businessId, t.conversationId],
      foreignColumns: [chatConversations.businessId, chatConversations.id],
    }).onDelete('cascade'),
  }),
);

export const chatAgents = pgTable(
  'chat_agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessId(),
    membershipId: uuid('membership_id').notNull(),
    available: boolean('available').notNull().default(false),
    capacity: integer('capacity').notNull().default(5),
    heartbeatUntil: timestamp('heartbeat_until', { withTimezone: true }),
    lastAssignedAt: timestamp('last_assigned_at', { withTimezone: true }),
  },
  (t) => ({
    agentKey: uniqueIndex('chat_agents_member').on(t.businessId, t.membershipId),
    capacityCheck: check('chat_agents_capacity_check', sql`${t.capacity} between 1 and 20`),
  }),
);

export const chatSettings = pgTable('chat_settings', {
  businessId: businessId().primaryKey(),
  configJson: jsonb('config_json').notNull().default({}),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const chatHelpRequests = pgTable(
  'chat_help_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessId(),
    conversationId: uuid('conversation_id').notNull(),
    requesterId: uuid('requester_id').notNull(),
    helperId: uuid('helper_id').notNull(),
    question: text('question').notNull(),
    status: text('status').notNull().default('requested'),
    version: integer('version').notNull().default(1),
    lastSequence: integer('last_sequence').notNull().default(0),
    requesterReadSequence: integer('requester_read_sequence').notNull().default(0),
    helperReadSequence: integer('helper_read_sequence').notNull().default(0),
    requesterTypingUntil: timestamp('requester_typing_until', { withTimezone: true }),
    helperTypingUntil: timestamp('helper_typing_until', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantKey: uniqueIndex('chat_help_tenant_key').on(t.businessId, t.id),
    conversationFk: foreignKey({
      columns: [t.businessId, t.conversationId],
      foreignColumns: [chatConversations.businessId, chatConversations.id],
    }).onDelete('cascade'),
    recipientIndex: index('chat_help_recipient').on(t.businessId, t.helperId, t.status),
    activeUnique: uniqueIndex('chat_help_active')
      .on(t.businessId, t.conversationId, t.helperId)
      .where(sql`${t.status} in ('requested','accepted')`),
    stateCheck: check(
      'chat_help_state',
      sql`${t.status} in ('requested','accepted','finished','cancelled')`,
    ),
    distinctPeople: check('chat_help_people', sql`${t.requesterId} <> ${t.helperId}`),
  }),
);

export const chatHelpMessages = pgTable(
  'chat_help_messages',
  {
    id: uuid('id').primaryKey(),
    businessId: businessId(),
    requestId: uuid('request_id').notNull(),
    senderId: uuid('sender_id').notNull(),
    sequence: integer('sequence').notNull(),
    body: text('body').notNull(),
    kind: text('kind').notNull().default('message'),
    mention: boolean('mention').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => ({
    requestFk: foreignKey({
      columns: [t.businessId, t.requestId],
      foreignColumns: [chatHelpRequests.businessId, chatHelpRequests.id],
    }).onDelete('cascade'),
    sequenceKey: uniqueIndex('chat_help_message_sequence').on(
      t.businessId,
      t.requestId,
      t.sequence,
    ),
    bodyCheck: check('chat_help_message_body', sql`length(btrim(${t.body})) between 1 and 4000`),
    kindCheck: check('chat_help_message_kind', sql`${t.kind} in ('message','suggestion')`),
  }),
);

export const chatTeamRooms = pgTable(
  'chat_team_rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessId(),
    key: text('key').notNull(),
    kind: text('kind').notNull(),
    locationId: uuid('location_id'),
    memberA: uuid('member_a'),
    memberB: uuid('member_b'),
    lastSequence: integer('last_sequence').notNull().default(0),
    revision: integer('revision').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantKey: uniqueIndex('chat_team_room_tenant').on(t.businessId, t.id),
    roomKey: uniqueIndex('chat_team_room_key').on(t.businessId, t.key),
    kindCheck: check(
      'chat_team_room_kind',
      sql`(${t.kind} = 'helpdesk' and ${t.locationId} is null and ${t.memberA} is null and ${t.memberB} is null) or (${t.kind} = 'store' and ${t.locationId} is not null and ${t.memberA} is null and ${t.memberB} is null) or (${t.kind} = 'direct' and ${t.locationId} is null and ${t.memberA} is not null and ${t.memberB} is not null and ${t.memberA} < ${t.memberB})`,
    ),
  }),
);
export const chatTeamMessages = pgTable(
  'chat_team_messages',
  {
    id: uuid('id').primaryKey(),
    businessId: businessId(),
    roomId: uuid('room_id').notNull(),
    senderId: uuid('sender_id').notNull(),
    body: text('body').notNull(),
    sequence: integer('sequence').notNull(),
    replyToId: uuid('reply_to_id'),
    mentionId: uuid('mention_id'),
    question: boolean('question').notNull().default(false),
    urgent: boolean('urgent').notNull().default(false),
    status: text('status').notNull().default('open'),
    assignedId: uuid('assigned_id'),
    saved: boolean('saved').notNull().default(false),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => ({
    roomFk: foreignKey({
      columns: [t.businessId, t.roomId],
      foreignColumns: [chatTeamRooms.businessId, chatTeamRooms.id],
    }).onDelete('cascade'),
    sequenceKey: uniqueIndex('chat_team_message_sequence').on(t.businessId, t.roomId, t.sequence),
    bodyCheck: check('chat_team_message_body', sql`length(btrim(${t.body})) between 1 and 4000`),
    stateCheck: check(
      'chat_team_message_state',
      sql`${t.status} in ('open','claimed','resolved') and (not ${t.urgent} or ${t.question})`,
    ),
  }),
);
export const chatTeamActivity = pgTable(
  'chat_team_activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: businessId(),
    roomId: uuid('room_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    readSequence: integer('read_sequence').notNull().default(0),
    typingUntil: timestamp('typing_until', { withTimezone: true }),
  },
  (t) => ({
    roomFk: foreignKey({
      columns: [t.businessId, t.roomId],
      foreignColumns: [chatTeamRooms.businessId, chatTeamRooms.id],
    }).onDelete('cascade'),
    memberKey: uniqueIndex('chat_team_activity_member').on(t.businessId, t.roomId, t.membershipId),
  }),
);
