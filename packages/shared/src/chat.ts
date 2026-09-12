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
