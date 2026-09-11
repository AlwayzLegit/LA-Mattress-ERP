export type LiveConversation = {
  id: string;
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
