import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { businesses } from './platform';
import { memberships } from './tenancy';
import { orderNotes, orders } from './orders';

export const orderTasks = pgTable(
  'order_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status').notNull().default('open'),
    priority: text('priority').notNull().default('normal'),
    assigneeMembershipId: uuid('assignee_membership_id').references(() => memberships.id, {
      onDelete: 'set null',
    }),
    createdByMembershipId: uuid('created_by_membership_id').references(() => memberships.id, {
      onDelete: 'set null',
    }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('order_tasks_business_idx').on(t.businessId),
    orderIdx: index('order_tasks_order_idx').on(t.orderId, t.createdAt),
    queueIdx: index('order_tasks_queue_idx').on(
      t.businessId,
      t.assigneeMembershipId,
      t.status,
      t.dueAt,
    ),
    statusCheck: check(
      'order_tasks_status_check',
      sql`${t.status} in ('open', 'in_progress', 'blocked', 'done')`,
    ),
    priorityCheck: check('order_tasks_priority_check', sql`${t.priority} in ('normal', 'high')`),
  }),
);

export const memberNotifications = pgTable(
  'member_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    recipientMembershipId: uuid('recipient_membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    actorMembershipId: uuid('actor_membership_id').references(() => memberships.id, {
      onDelete: 'set null',
    }),
    /**
     * Null for notices that are not about an order — a competition
     * overtake (redesign Phase 11). Every task / note notice keeps its order.
     */
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => orderTasks.id, { onDelete: 'cascade' }),
    noteId: uuid('note_id').references(() => orderNotes.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    message: text('message').notNull().default(''),
    eventKey: text('event_key').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    businessIdx: index('member_notifications_business_idx').on(t.businessId),
    inboxIdx: index('member_notifications_inbox_idx').on(
      t.businessId,
      t.recipientMembershipId,
      t.createdAt,
    ),
    eventUnique: uniqueIndex('member_notifications_event_uniq').on(
      t.businessId,
      t.recipientMembershipId,
      t.eventKey,
    ),
  }),
);
