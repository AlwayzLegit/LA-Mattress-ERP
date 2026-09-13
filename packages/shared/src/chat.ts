import { z } from 'zod';

export const CHAT_CONTRACT_VERSION = '1.0.0' as const;
export const CHAT_STATUSES = [
  'queued',
  'open',
  'waiting_customer',
  'snoozed',
  'resolved',
  'spam',
] as const;
export const chatMessageInputSchema = z
  .object({
    clientMessageId: z.string().uuid(),
    body: z.string().trim().min(1).max(4000),
  })
  .strict();
export const chatHistoryQuerySchema = z
  .object({
    afterSequence: z.coerce.number().int().min(0).max(2147483646).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type ChatMessageInput = z.infer<typeof chatMessageInputSchema>;
export type ChatHistoryQuery = z.infer<typeof chatHistoryQuerySchema>;

// Deliberately exclude business/session/author IDs and staff-only metadata.
export interface VisitorChatMessage {
  id: string;
  conversationId: string;
  sequence: number;
  sender: 'visitor' | 'staff';
  body: string;
  createdAt: string;
  persisted: true;
}
export interface ChatHistoryPage {
  activity?: {
    teamAvailable?: boolean;
    availability?: 'available' | 'busy' | 'outside_hours';
    staffReadSequence: number;
    typing: boolean;
    status: string;
  };
  data: VisitorChatMessage[];
  nextSequence: number;
  hasMore: boolean;
}

export const chatActivitySchema = z
  .object({
    readSequence: z.number().int().min(0).max(2147483646).optional(),
    typing: z.boolean().optional(),
    sharedDraft: z
      .object({ consent: z.boolean(), text: z.string().max(4000) })
      .strict()
      .refine((value) => value.consent || value.text === '', 'Draft sharing requires consent')
      .optional(),
    currentPage: z
      .object({
        path: z
          .string()
          .max(500)
          .regex(/^\/(?:$|(?:products|collections|pages|blogs)\/[a-zA-Z0-9/_-]+$|sleep-quiz\/?$)/),
        title: z.string().trim().min(1).max(160),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export const chatWorkflowSchema = z
  .object({
    action: z.enum(['claim', 'release', 'resolve', 'reopen', 'spam', 'snooze']),
    version: z.number().int().positive(),
    snoozedUntil: z.string().datetime().optional(),
  })
  .strict();

export const chatPushSubscriptionSchema = z
  .object({
    endpoint: z.string().url().max(2048),
    keys: z
      .object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
        auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
      })
      .strict(),
    expirationTime: z.number().nullable().optional(),
  })
  .strict();

export const chatAvailabilitySchema = z
  .object({ available: z.boolean(), capacity: z.number().int().min(1).max(20) })
  .strict();

export const chatFollowupSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    method: z.enum(['email', 'phone']),
    contact: z.string().trim().min(5).max(254),
    consent: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.method === 'email'
        ? !z.string().email().safeParse(value.contact).success
        : !/^[+0-9 ()-]{7,30}$/.test(value.contact)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['contact'],
        message: 'Enter a valid email address or phone number.',
      });
  });

const chatTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
export const chatSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    notificationsEnabled: z.boolean().default(true),
    requireNotifications: z.boolean().default(true),
    autoAvailable: z.boolean().default(true),
    allowAway: z.boolean().default(false),
    awayAllowedMembers: z.array(z.string().uuid()).max(500).default([]),
    notificationExemptMembers: z.array(z.string().uuid()).max(500).default([]),
    autoAssign: z.boolean().default(false),
    sharedInbox: z.boolean().default(false),
    hoursEnabled: z.boolean().default(false),
    hours: z
      .array(
        z
          .object({ day: z.number().int().min(0).max(6), open: chatTime, close: chatTime })
          .strict()
          .refine((row) => row.close > row.open, 'Closing time must follow opening time'),
      )
      .max(7)
      .default([]),
    holidays: z
      .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .max(100)
      .default([]),
    responseMinutes: z.number().int().min(1).max(1440).default(10),
    acceptanceMinutes: z.number().int().min(1).max(60).default(2),
    retentionDays: z.number().int().min(30).max(3650).nullable().default(null),
    templates: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(80),
            body: z.string().trim().min(1).max(4000),
          })
          .strict(),
      )
      .max(50)
      .default([]),
  })
  .strict()
  .refine(
    (value) => new Set(value.hours.map((row) => row.day)).size === value.hours.length,
    'Only one schedule per day',
  );
export type ChatSettings = z.infer<typeof chatSettingsSchema>;
export const chatContextSchema = z
  .object({
    topic: z.enum(['mattress', 'showroom', 'delivery', 'order', 'other']).default('other'),
    locationId: z.string().uuid().nullable().default(null),
    pagePath: z
      .string()
      .max(500)
      .regex(/^\/(?!\/)[^?#]*$/)
      .default('/'),
  })
  .strict();
export const chatTransferSchema = z
  .object({ membershipId: z.string().uuid(), version: z.number().int().positive() })
  .strict();
export const chatLinkSchema = z
  .object({
    customerId: z.string().uuid().nullable(),
    verificationConfirmed: z.literal(true),
    version: z.number().int().positive(),
  })
  .strict();

export const chatHelpRequestSchema = z
  .object({
    id: z.string().uuid(),
    helperId: z.string().uuid(),
    question: z.string().trim().min(1).max(1000),
  })
  .strict();
export const chatHelpActionSchema = z
  .object({
    action: z.enum(['accept', 'finish', 'cancel']),
    version: z.number().int().positive(),
  })
  .strict();

export const chatHelpMessageSchema = z
  .object({
    id: z.string().uuid(),
    body: z.string().trim().min(1).max(4000),
    kind: z.enum(['message', 'suggestion']).default('message'),
    mention: z.boolean().default(false),
  })
  .strict();
export const chatHelpActivitySchema = z
  .object({
    readSequence: z.number().int().nonnegative().optional(),
    typing: z.boolean().optional(),
  })
  .strict();

export const chatTeamRoomSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('helpdesk') }).strict(),
  z.object({ kind: z.literal('store'), locationId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('direct'), memberId: z.string().uuid() }).strict(),
]);
export const chatTeamMessageSchema = z
  .object({
    id: z.string().uuid(),
    body: z.string().trim().min(1).max(4000),
    replyToId: z.string().uuid().optional(),
    mentionId: z.string().uuid().optional(),
    question: z.boolean().default(false),
    urgent: z.boolean().default(false),
  })
  .strict();
export const chatTeamActionSchema = z
  .object({
    action: z.enum(['claim', 'release', 'resolve', 'reopen', 'save', 'unsave']),
    version: z.number().int().positive(),
  })
  .strict();

export const chatTeamHistorySchema = z
  .object({
    beforeSequence: z.coerce.number().int().positive().optional(),
    filter: z.enum(['all', 'open', 'saved']).default('all'),
  })
  .strict();
