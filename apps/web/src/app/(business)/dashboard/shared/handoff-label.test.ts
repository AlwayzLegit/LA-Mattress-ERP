import { describe, expect, it } from 'vitest';
import { handoffLabel } from './kit';
import type { PickupSummary } from './types';

const base: PickupSummary = {
  id: 'p1',
  number: 'PU-0012',
  recordedAt: '2026-09-30T22:14:00Z',
  byName: 'Dana Whitmore',
  countedCents: 124_000,
  expectedCents: 124_000,
  varianceCents: 0,
  slip: null,
  note: null,
  paymentCount: 3,
  items: [],
};
const TZ = 'America/Los_Angeles';

describe('handoffLabel (owner cash hand-off)', () => {
  it('says the cash is still with the operator until the owner ticks it', () => {
    expect(handoffLabel({ ...base, ownerReceipt: null }, TZ)).toBe(
      'with Dana Whitmore — not yet with the owner',
    );
  });

  it('names the owner and the moment once handed over', () => {
    expect(
      handoffLabel(
        {
          ...base,
          ownerReceipt: {
            receivedAt: '2026-09-30T23:10:00Z',
            byName: 'Olive Owner',
            from: 'operator',
          },
        },
        TZ,
      ),
    ).toBe('handed to Olive Owner Sep 30 4:10 PM');
  });

  it('reads as with the owner when the owner took it from the store', () => {
    expect(
      handoffLabel(
        {
          ...base,
          byName: 'Olive Owner',
          ownerReceipt: { receivedAt: base.recordedAt, byName: 'Olive Owner', from: 'store' },
        },
        TZ,
      ),
    ).toBe('with the owner');
  });

  it('stays quiet for legacy pickups and an older API', () => {
    expect(
      handoffLabel(
        { ...base, ownerReceipt: { receivedAt: base.recordedAt, byName: null, from: 'legacy' } },
        TZ,
      ),
    ).toBe('');
    expect(handoffLabel(base, TZ)).toBe('');
  });
});
