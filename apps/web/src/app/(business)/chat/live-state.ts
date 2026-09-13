export type LiveConversation = {
  id: string;
  preview?: string | null;
  visitorName?: string | null;
  assignedName?: string | null;
  createdAt?: string;
  version?: number;
  overdue?: boolean;
  acceptedAt?: string | null;
  assignedAt?: string | null;
  awaitingSince?: string | null;
  locationId?: string | null;
  followupPending?: boolean;
  assignedMembershipId?: string | null;
  assignedToMe?: boolean;
  visitorReadSequence?: number;
  staffReadSequence?: number;
  visitorTyping?: boolean;
  visitorOnline?: boolean | null;
  canTakeOver?: boolean;
  status: string;
  updatedAt: string;
  lastSequence: number;
  visitorSequence: number;
};

/** Initial history is a baseline, reconnects keep the previous watermark. */
export function incomingConversations(
  previous: Map<string, number> | null,
  rows: LiveConversation[],
) {
  if (!previous) return [];
  return rows.filter((row) => row.visitorSequence > (previous.get(row.id) ?? 0));
}

/** Pending assignments must alert even when no new visitor message arrives. */
export function incomingHandoffs(previous: Map<string, string | null>, rows: LiveConversation[]) {
  return rows.filter(
    (row) =>
      ((row.assignedToMe && row.status === 'open') ||
        (!row.assignedMembershipId &&
          row.status === 'queued' &&
          row.canTakeOver &&
          previous.has(row.id))) &&
      !row.acceptedAt &&
      row.assignedAt &&
      previous.get(row.id) !== row.assignedAt,
  );
}
