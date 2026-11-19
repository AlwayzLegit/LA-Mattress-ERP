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

describe('describeOrderEvent (the KO-10117 history, owner 2026-10-13)', () => {
  it('reads an old-style update without the noise', () => {
    const e = describeOrderEvent(
      row({
        action: 'order.update',
        actorName: 'Elyse',
        changesJson: {
          before: { status: 'open', totalCents: 50_000 },
          after: {
            status: 'open',
            orderKind: 'sales_order',
            updatedAt: '2026-10-13T21:40:45.098Z',
            requestedDate: '2026-10-14',
          },
        },
      }),
    );
    expect(e.text).toBe('Elyse updated the order: delivery date 2026-10-14');
  });

  it('reads a new-style update as before → after', () => {
    const e = describeOrderEvent(
      row({
        action: 'order.update',
        actorName: 'Elyse',
        changesJson: {
          before: { status: 'open', totalCents: 50_000, requestedDate: '2026-10-13' },
          after: { status: 'open', totalCents: 50_000, requestedDate: '2026-10-14' },
        },
      }),
    );
    expect(e.text).toBe('Elyse updated the order: delivery date 2026-10-13 → 2026-10-14');
  });

  it('reads a fee, and a fee on a linked order', () => {
    expect(
      describeOrderEvent(
        row({
          action: 'order.fee_charged',
          actorName: 'Elyse',
          changesJson: { after: { label: 'Redelivery fee', amountCents: 7500 } },
        }),
      ).text,
    ).toBe('Elyse charged Redelivery fee $75.00');
    expect(
      describeOrderEvent(
        row({
          action: 'order.fee_charged',
          actorName: 'Elyse',
          changesJson: {
            after: { label: 'Redelivery fee', amountCents: 7500, feeOrderNumber: 'KO-10117-FEE' },
          },
        }),
      ).text,
    ).toBe('Elyse charged Redelivery fee $75.00 on KO-10117-FEE (this order was closed)');
  });
});

describe('more detail so the owner need not investigate (WE-10091, owner 2026-11-19)', () => {
  const LUCILLE = '35731b17-17a8-40d6-ad08-d10d55ece0c4';
  const ELYSE = '51e34602-d0ed-4cc9-827a-5ff4639e5939';
  const KOREATOWN = 'f2bf921b-9898-499f-b06d-5a3fc909b400';
  const elyse = (over: Partial<OrderAuditRow>) => row({ actorName: 'Elyse', ...over });

  it('names the item on a line change (the after carries lineId: null)', () => {
    const e = describeOrderEvent(
      elyse({
        action: 'order.line.update',
        changesJson: {
          before: { lineId: LUCILLE, fulfillmentMethod: null },
          after: { lineId: null, fulfillmentMethod: 'delivery' },
        },
        names: { [LUCILLE]: 'E KING LUCILLE 2.0 LUXE FIRM' },
      }),
    );
    expect(e.text).toBe('Elyse changed E KING LUCILLE 2.0 LUXE FIRM: fulfillment none → delivery');
  });

  it('says a Save that changed nothing changed nothing', () => {
    const e = describeOrderEvent(elyse({ action: 'order.update', changesJson: null }));
    expect(e.text).toBe('Elyse saved Order details with no changes');
    expect(e.tone).toBe('muted');
  });

  it('shows every field that moved, with addresses, stores and notes spelled out', () => {
    const e = describeOrderEvent(
      elyse({
        action: 'order.update',
        changesJson: {
          before: {
            requestedDate: '2026-11-14',
            salespersonMembershipId: ELYSE,
            pickupLocationId: null,
            addressLine1: '1 Main St',
            billingAddressJson: null,
            deliveryInstructions: null,
            orderSource: 'walk-in',
          },
          after: {
            requestedDate: '2026-11-13',
            salespersonMembershipId: null,
            pickupLocationId: KOREATOWN,
            addressLine1: '22 Oak Ave',
            billingAddressJson: {
              line1: '9 Pine Rd',
              city: 'Los Angeles',
              region: 'CA',
              postalCode: '90004',
            },
            deliveryInstructions: 'Call   before\narrival',
            orderSource: 'phone',
          },
        },
        names: { [ELYSE]: 'Elyse', [KOREATOWN]: 'Koreatown' },
      }),
    );
    expect(e.text).toBe(
      'Elyse updated the order: delivery date 2026-11-14 → 2026-11-13, salesperson Elyse → none, ' +
        'pickup store none → Koreatown, delivery address 1 Main St → 22 Oak Ave, ' +
        'billing address none → 9 Pine Rd, Los Angeles, CA 90004, ' +
        'delivery instructions none → “Call before arrival”, order source walk-in → phone',
    );
  });

  it('reads notes, tasks, attachments and stock moves in full', () => {
    const say = (over: Partial<OrderAuditRow>) => describeOrderEvent(elyse(over)).text;
    expect(
      say({ action: 'order.note.add', changesJson: { after: { preview: 'Customer wants AM' } } }),
    ).toBe('Elyse added a note: “Customer wants AM”');
    expect(
      say({
        action: 'order.task.create',
        changesJson: {
          after: {
            title: 'Confirm address',
            assigneeMembershipId: ELYSE,
            dueAt: '2026-11-12T08:00:00Z',
          },
        },
        names: { [ELYSE]: 'Elyse' },
      }),
    ).toBe('Elyse added a task “Confirm address” for Elyse due 2026-11-12');
    expect(
      say({
        action: 'order.task.update',
        changesJson: {
          before: { taskId: 't1', status: 'open' },
          after: { status: 'done' },
          metadata: { taskTitle: 'Confirm address' },
        },
      }),
    ).toBe('Elyse updated task “Confirm address”: status open → done');
    expect(
      say({ action: 'order.attachment.add', changesJson: { after: { name: 'receipt.pdf' } } }),
    ).toBe('Elyse attached receipt.pdf');
    expect(
      say({ action: 'order.reserve', changesJson: { after: { reserved: 3, short: 1 } } }),
    ).toBe('Elyse reserved 3 units of stock, 1 still short');
  });

  it('spells out delivery ticket flag moves', () => {
    const e = describeOrderEvent(
      row({
        actorName: 'Henry',
        action: 'delivery.ticket_flags',
        changesJson: {
          metadata: {
            reason: 'header_change',
            transitions: [
              { record: 'header', date: '2026-11-13', from: 'P', to: 'R', rule: 'r1' },
              { record: LUCILLE, date: '2026-11-13', from: null, to: 'P', rule: 'print' },
            ],
          },
        },
        names: { [LUCILLE]: 'E KING LUCILLE 2.0 LUXE FIRM' },
      }),
    );
    expect(e.text).toBe(
      'Henry updated the delivery ticket flags (header change): ticket 2026-11-13: printed → needs a reprint; ' +
        'E KING LUCILLE 2.0 LUXE FIRM 2026-11-13: not printed → printed',
    );
  });
});
