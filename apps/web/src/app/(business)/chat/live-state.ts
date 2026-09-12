export type LiveConversation = {
  id: string;
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
