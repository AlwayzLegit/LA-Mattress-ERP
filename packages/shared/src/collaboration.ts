import { z } from 'zod';

export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done'] as const;
export const taskCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2000).default(''),
    assigneeMembershipId: z.string().uuid().nullable().default(null),
    dueAt: z.string().datetime({ offset: true }).nullable().default(null),
    priority: z.enum(['normal', 'high']).default('normal'),
  })
  .strict();
// Update fields intentionally have no creation defaults: an omitted owner or
// deadline must survive a status-only edit (including under Zod 4).
export const taskUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(2000).optional(),
    assigneeMembershipId: z.string().uuid().nullable().optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    priority: z.enum(['normal', 'high']).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    version: z.number().int().positive(),
  })
  .strict();
export const orderNoteInputSchema = z
  .object({
    body: z.string().trim().min(1).max(4000),
    mentionedMembershipIds: z.array(z.string().uuid()).max(20).default([]),
  })
  .strict();

export interface OrderTeamMember {
  id: string;
  name: string;
  roleName: string;
}
export interface OrderTaskRow {
  id: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  title: string;
  description: string;
  status: (typeof TASK_STATUSES)[number];
  priority: 'normal' | 'high';
  assigneeMembershipId: string | null;
  assigneeName: string | null;
  assigneeActive: boolean;
  createdByMembershipId: string | null;
  dueAt: string | null;
  completedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface TaskPage {
  data: OrderTaskRow[];
  total: number;
  offset: number;
  limit: number;
  counts: { mine: number; overdue: number; blocked: number; unassigned: number };
}
export interface InboxNotification {
  id: string;
  kind: string;
  title: string;
  message: string;
  /** Null for notices that are not about an order (competition overtakes). */
  orderId: string | null;
  orderNumber: string | null;
  taskId: string | null;
  noteId: string | null;
  createdAt: string;
  readAt: string | null;
}
export interface InboxPage {
  data: InboxNotification[];
  unread: number;
  membershipId: string | null;
  businessId: string;
}
