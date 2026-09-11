import { describe, expect, it } from 'vitest';
import { chatHistoryQuerySchema, chatMessageInputSchema } from './chat.js';

const clientMessageId = 'dca8232a-87cf-48b1-8322-01f6f52e06dd';
describe('chat request boundary', () => {
  it('rejects empty, oversized and forged-author input', () => {
    for (const body of ['', '   ', 'x'.repeat(4001)])
      expect(chatMessageInputSchema.safeParse({ clientMessageId, body }).success).toBe(false);
    expect(
      chatMessageInputSchema.safeParse({
        clientMessageId,
        body: 'Hello',
        senderId: clientMessageId,
      }).success,
    ).toBe(false);
    expect(
      chatMessageInputSchema.safeParse({
        clientMessageId,
        body: 'Hello',
        businessId: clientMessageId,
      }).success,
    ).toBe(false);
    expect(
      chatMessageInputSchema.safeParse({ clientMessageId, body: 'Hello', audience: 'internal' })
        .success,
    ).toBe(false);
  });
  it('normalizes message whitespace before duplicate fingerprints are computed', () => {
    expect(chatMessageInputSchema.parse({ clientMessageId, body: '  Hello  ' }).body).toBe('Hello');
  });
  it('bounds history inputs including negative, fractional and unbounded cursors', () => {
    expect(chatHistoryQuerySchema.parse({})).toEqual({ afterSequence: 0, limit: 50 });
    for (const query of [
      { limit: 101 },
      { limit: 0 },
      { afterSequence: -1 },
      { afterSequence: 0.5 },
      { afterSequence: Infinity },
      { businessId: clientMessageId },
    ])
      expect(chatHistoryQuerySchema.safeParse(query).success).toBe(false);
  });
});
