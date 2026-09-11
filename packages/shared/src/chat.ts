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
  data: VisitorChatMessage[];
  nextSequence: number;
  hasMore: boolean;
}
