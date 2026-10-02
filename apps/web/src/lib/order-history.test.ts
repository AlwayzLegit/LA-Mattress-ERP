import { describe, expect, it } from 'vitest';
import { describeOrderEvent, type OrderAuditRow } from './order-history';

const row = (over: Partial<OrderAuditRow>): OrderAuditRow => ({
  id: 'a1',
  action: 'order.create',
  createdAt: '2026-09-25T17:24:41Z',
  actorEmail: 'ronnie.lamattress@gmail.com',
  actorName: 'Ronnie',
  changesJson: null,
  names: {},
  ...over,
});

const LINE = 'dbb1d913-6483-46fe-aac2-03a268522386';
const VARIANT = 'd6944cf0-b9be-4cb0-b481-929f252afa65';

describe('describeOrderEvent (the WE-10021 history, owner 2026-10-02)', () => {
  it('says who created the order, with items, total and deposit', () => {
    const e = describeOrderEvent(
      row({
        changesJson: {
          after: {
            number: 'WE-10021',
            status: 'open',
            lineCount: 4,
            customerId: '4b541f79-2151-483d-b147-6e433500cda2',
            totalCents: 182_800,
            depositRequiredCents: 45_700,
          },
        },
      }),
    );
    expect(e.text).toBe('Ronnie created WE-10021 · 4 items · $1,828.00 · deposit due $457.00');
  });

  it('reads a card deposit', () => {
    const e = describeOrderEvent(
      row({
        action: 'order.payment.take',
        changesJson: {
          after: { kind: 'deposit', method: 'card', paymentId: LINE, amountCents: 182_800 },
        },
      }),
    );
    expect(e.text).toBe('Ronnie took a $1,828.00 card deposit');
  });

  it('names the product on line add and remove, never the ids', () => {
    const add = describeOrderEvent(
      row({
        action: 'order.line.add',
        actorName: 'Henry',
        actorEmail: 'henrym.lamattress@gmail.com',
        changesJson: { after: { lineId: LINE, variantId: VARIANT, quantity: 2 } },
        names: { [VARIANT]: 'QUEEN TWILIGHT FIRM', [LINE]: 'QUEEN TWILIGHT FIRM' },
      }),
    );
    expect(add.text).toBe('Henry added 2 × QUEEN TWILIGHT FIRM');
    const removed = describeOrderEvent(
      row({
        action: 'order.line.remove',
        actorName: 'Henry',
        changesJson: { before: { lineId: LINE, variantId: VARIANT, quantity: 2 } },
        names: { [VARIANT]: 'QUEEN X-PLAT BED FRAME' },
      }),
    );
    expect(removed.text).toBe('Henry removed 2 × QUEEN X-PLAT BED FRAME');
    expect(removed.text).not.toMatch(/[0-9a-f]{8}-/);
  });

  it('a line with no product (fee, custom) uses the line name', () => {
    const e = describeOrderEvent(
      row({
        action: 'order.line.add',
        actorName: 'Henry',
        changesJson: { after: { lineId: LINE, variantId: null, quantity: 2 } },
        names: { [LINE]: 'Recycling Fee' },
      }),
    );
    expect(e.text).toBe('Henry added 2 × Recycling Fee');
  });

  it('a line edit lists what changed in words', () => {
    const e = describeOrderEvent(
      row({
        action: 'order.line.update',
        changesJson: {
          before: { lineId: LINE, unitPriceCents: 104_900, quantity: 1 },
          after: { unitPriceCents: 99_900, quantity: 2 },
        },
        names: { [LINE]: 'QUEEN TWILIGHT FIRM' },
      }),
    );
    expect(e.text).toBe(
      'Ronnie changed QUEEN TWILIGHT FIRM: price $1,049.00 → $999.00, quantity 1 → 2',
    );
  });

  it('falls back to the email, then System, when there is no name', () => {
    expect(describeOrderEvent(row({ action: 'order.note.add', actorName: null })).text).toBe(
      'ronnie.lamattress@gmail.com added a note',
    );
    expect(
      describeOrderEvent(row({ action: 'order.note.add', actorName: null, actorEmail: null })).who,
    ).toBe('System');
  });

  it('an unknown action still reads, without ids', () => {
    const e = describeOrderEvent(
      row({
        action: 'order.something_new',
        changesJson: { before: { status: 'open', lineId: LINE }, after: { status: 'completed' } },
      }),
    );
    expect(e.text).toBe('Ronnie something new: status open → completed');
  });
});
