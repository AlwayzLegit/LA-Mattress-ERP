import { describe, expect, it } from 'vitest';
import { incomingHandoffs, incomingConversations, type LiveConversation } from './live-state';
const row = (
  id: string,
  visitorSequence: number,
  lastSequence = visitorSequence,
): LiveConversation => ({
  id,
  visitorSequence,
  lastSequence,
  status: 'open',
  updatedAt: '2026-09-11T12:00:00Z',
});
describe('incoming chat alerts', () => {
  it('does not notify for the initial history', () =>
    expect(incomingConversations(null, [row('a', 4)])).toEqual([]));
  it('ignores repeated snapshots, staff replies, and private notes', () =>
    expect(incomingConversations(new Map([['a', 4]]), [row('a', 4, 7)])).toEqual([]));
  it('catches up once after a reconnect and includes new conversations', () => {
    const rows = [row('a', 6), row('b', 1)];
    expect(incomingConversations(new Map([['a', 4]]), rows)).toEqual(rows);
    expect(
      incomingConversations(new Map(rows.map((r) => [r.id, r.visitorSequence])), rows),
    ).toEqual([]);
  });
});

describe('handoff alerts', () => {
  it('alerts on a new pending assignment without a visitor message and deduplicates snapshots', () => {
    const pending = {
      ...row('a', 4),
      assignedToMe: true,
      assignedAt: '2026-09-13T12:00:00Z',
      acceptedAt: null,
    };
    expect(incomingHandoffs(new Map(), [pending])).toEqual([pending]);
    expect(incomingHandoffs(new Map([['a', pending.assignedAt]]), [pending])).toEqual([]);
    expect(
      incomingHandoffs(new Map([['a', pending.assignedAt]]), [
        { ...pending, assignedAt: '2026-09-13T12:01:00Z' },
      ]),
    ).toHaveLength(1);
  });
  it('does not alert for other agents, accepted assignments, or closed chats', () => {
    const pending = { ...row('a', 4), assignedToMe: true, assignedAt: '2026-09-13T12:00:00Z' };
    expect(
      incomingHandoffs(new Map(), [
        { ...pending, assignedToMe: false },
        { ...pending, acceptedAt: pending.assignedAt },
        { ...pending, status: 'resolved' },
      ]),
    ).toEqual([]);
  });
});
