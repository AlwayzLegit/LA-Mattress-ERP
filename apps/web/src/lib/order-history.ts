/**
 * Order change history in plain sentences (owner 2026-10-02: "make the
 * Change history easier to understand"). Each audit entry becomes one
 * line — "Henry added 2 × QUEEN TWILIGHT FIRM", "Ronnie took a $1,828.00
 * card deposit" — with the member's name (email on hover), products by
 * name only, and internal ids hidden. The API sends `names` for every id
 * in the payload (lines and variants → product name, locations, members).
 */

export interface OrderAuditRow {
  id: string;
  action: string;
  createdAt: string;
  actorEmail: string | null;
  actorName?: string | null;
  changesJson: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  } | null;
  names?: Record<string, string>;
}

export interface OrderEvent {
  /** The whole sentence, actor first. */
  text: string;
  /** Who did it, as shown (name, else email, else "System"). */
  who: string;
  /** Dot colour on the order sheet timeline. */
  tone: 'accent' | 'fulfilled' | 'scheduled' | 'waiting' | 'muted' | 'risk';
}

const METHOD: Record<string, string> = {
  card: 'card',
  cash: 'cash',
  check: 'check',
  paypal: 'PayPal',
  venmo: 'Venmo',
  zelle: 'Zelle',
  synchrony: 'Synchrony',
  acima: 'Acima',
  store_credit: 'store credit',
  gift_card: 'gift card',
  financing: 'financing',
  external_card: 'card',
};

const LINE_TYPE: Record<string, string> = {
  stock: 'stock',
  special_order: 'special order',
  direct_ship: 'direct ship',
  custom: 'custom',
};

/** Field labels for "changed …" sentences; anything else is humanised. */
const FIELD: Record<string, string> = {
  quantity: 'quantity',
  unitPriceCents: 'price',
  discountCents: 'discount',
  lineDiscountCents: 'discount',
  totalCents: 'total',
  description: 'description',
  fulfillmentMethod: 'fulfillment',
  fulfillmentType: 'fulfillment',
  sourceLocationId: 'ship-from',
  locationId: 'store',
  requestedDate: 'delivery date',
  deliveryDate: 'delivery date',
  promisedDate: 'promised date',
  status: 'status',
  notes: 'notes',
  size: 'size',
  salespersonMembershipId: 'salesperson',
  secondSalespersonMembershipId: 'second salesperson',
  splitBps: 'commission split',
  taxRateBps: 'tax rate',
  depositRequiredCents: 'deposit due',
  customerId: 'customer',
};

export function money(cents: unknown): string {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return '';
  const sign = cents < 0 ? '−' : '';
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function humanise(key: string): string {
  return key
    .replace(/(Cents|Bps|Id)$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function actorOf(row: OrderAuditRow): string {
  const name = row.actorName?.trim();
  if (name) return name;
  if (row.actorEmail) return row.actorEmail;
  return 'System';
}

/** One field value, readable: money, names for ids, dates, labels. */
function value(key: string, v: unknown, names: Record<string, string>): string {
  if (v == null || v === '') return 'none';
  if (/Cents$/.test(key)) return money(v);
  if (/Bps$/.test(key) && typeof v === 'number') return `${v / 100}%`;
  if (typeof v === 'string') {
    if (names[v.toLowerCase()]) return names[v.toLowerCase()]!;
    if (/Id$/.test(key)) return '—';
    if (key === 'lineType') return LINE_TYPE[v] ?? v.replace(/_/g, ' ');
    if (key === 'status' || /method|type/i.test(key)) return v.replace(/_/g, ' ');
    return v;
  }
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return String(v);
  return '…';
}

/** "price $1,049.00 → $999.00, quantity 1 → 2" for the keys that changed. */
function changes(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  names: Record<string, string>,
  skip: string[] = [],
): string {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (k) =>
      !skip.includes(k) &&
      (!/Id$/.test(k) || k in FIELD) &&
      JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null) &&
      (typeof (after[k] ?? before[k]) !== 'object' || (after[k] ?? before[k]) === null),
  );
  return keys
    .slice(0, 4)
    .map((k) => {
      const label = FIELD[k] ?? humanise(k);
      return k in before
        ? `${label} ${value(k, before[k], names)} → ${value(k, after[k], names)}`
        : `${label} ${value(k, after[k], names)}`;
    })
    .join(', ');
}

function item(id: unknown, names: Record<string, string>, fallback = 'an item'): string {
  if (typeof id === 'string' && names[id.toLowerCase()]) return names[id.toLowerCase()]!;
  return fallback;
}

/** The sentence for one order audit entry. */
export function describeOrderEvent(row: OrderAuditRow): OrderEvent {
  const who = actorOf(row);
  const a = row.changesJson?.after ?? {};
  const b = row.changesJson?.before ?? {};
  const m = row.changesJson?.metadata ?? {};
  const names = Object.fromEntries(
    Object.entries(row.names ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const say = (text: string, tone: OrderEvent['tone'] = 'accent'): OrderEvent => ({
    text: `${who} ${text}`,
    who,
    tone,
  });
  const lineName = (src: Record<string, unknown>) =>
    item(src.variantId, names, '') || item(src.lineId, names);
  const qty = (n: unknown) => (typeof n === 'number' && n > 0 ? `${n} × ` : '');

  switch (row.action) {
    case 'order.create': {
      const parts = [
        typeof a.number === 'string' ? `created ${a.number}` : 'created the order',
        typeof a.lineCount === 'number' ? plural(a.lineCount, 'item') : '',
        typeof a.totalCents === 'number' ? money(a.totalCents) : '',
        typeof a.depositRequiredCents === 'number' && a.depositRequiredCents > 0
          ? `deposit due ${money(a.depositRequiredCents)}`
          : '',
      ].filter(Boolean);
      return say(parts.join(' · '));
    }
    case 'order.payment.take': {
      const method = METHOD[String(a.method ?? '')] ?? String(a.method ?? '').replace(/_/g, ' ');
      const kind = a.kind === 'deposit' ? 'deposit' : 'payment';
      const amount = money(a.amountCents);
      return say(`took a ${[amount, method, kind].filter(Boolean).join(' ')}`, 'fulfilled');
    }
    case 'order.line.add':
      return say(`added ${qty(a.quantity)}${lineName(a)}`);
    case 'order.line.remove':
      return say(`removed ${qty(b.quantity)}${lineName(b)}`, 'muted');
    case 'order.line.update': {
      const what = changes(b, a, names, ['lineId']);
      const name = lineName({ ...b, ...a });
      return say(what ? `changed ${name}: ${what}` : `edited ${name}`);
    }
    case 'order.line.line_type':
      return say(
        `changed ${lineName(b)} to ${LINE_TYPE[String(a.lineType)] ?? String(a.lineType ?? '').replace(/_/g, ' ')}`,
      );
    case 'order.line.release':
      return say(
        `released ${typeof a.released === 'number' ? `${a.released} reserved ` : 'the reservation on '}${lineName(a)}`,
        'waiting',
      );
    case 'order.line.split':
      return say(
        `split ${lineName(a)}: ${String(a.quantity ?? '')} stay, ${String(a.newQuantity ?? '')} moved to a new line`,
      );
    case 'order.lines.discount': {
      const n = Array.isArray(a.lines) ? a.lines.length : 0;
      const v =
        a.mode === 'percent' && typeof a.value === 'number'
          ? ` (${a.value}%)`
          : typeof a.value === 'number'
            ? ` (${money(a.value)})`
            : '';
      return say(`discounted ${plural(n, 'line')}${v}`);
    }
    case 'order.remove_overrides': {
      const n = Array.isArray(a.changes) ? a.changes.length : 0;
      return say(`restored list prices on ${plural(n, 'line')}`);
    }
    case 'order.update': {
      const what = changes(b, a, names);
      return say(what ? `updated the order: ${what}` : 'updated the order');
    }
    case 'order.selling_store.correct':
      return say(
        `moved the sale from ${String(b.locationName ?? 'one store')} to ${String(a.locationName ?? 'another')}${a.reason ? ` — ${String(a.reason)}` : ''}`,
      );
    case 'order.lock':
      return say('printed the delivery ticket — order locked', 'scheduled');
    case 'order.unlock':
      return say(
        `unlocked the order${a.reason || a.reasonText ? ` — ${String(a.reason ?? a.reasonText)}` : ''}`,
        'scheduled',
      );
    case 'order.cancel': {
      const deposit =
        typeof a.depositCents === 'number' && a.depositCents > 0
          ? ` · ${money(a.depositCents)} deposit to ${a.depositTo === 'store_credit' ? 'store credit' : 'refund'}`
          : '';
      return say(
        `cancelled the order${a.reason ? ` — ${String(a.reason)}` : ''}${deposit}`,
        'muted',
      );
    }
    case 'order.reserve':
      return say('reserved stock', 'scheduled');
    case 'order.release':
      return say('released the reserved stock', 'waiting');
    case 'order.auto_stock_release':
      return { text: 'Reserved stock was released automatically', who, tone: 'waiting' };
    case 'order.allocate_pending':
      return { text: 'A line is short of stock at its ship-from store', who, tone: 'waiting' };
    case 'order.price_adjustment':
      return say(`adjusted the price by ${money(a.amountCents)}`, 'waiting');
    case 'order.note.add':
      return say('added a note');
    case 'order.fulfill':
      return say(
        `handed over ${typeof a.units === 'number' ? plural(a.units, 'unit') : 'the goods'}`,
        'fulfilled',
      );
    case 'order.complete':
      return say(
        `completed the order${typeof a.balanceDueCents === 'number' && a.balanceDueCents > 0 ? ` with ${money(a.balanceDueCents)} still due` : ''}`,
        'fulfilled',
      );
    case 'order.return_authorized':
      return say(
        `started return ${String(a.rmaNumber ?? '')}${typeof a.unitCount === 'number' ? ` · ${plural(a.unitCount, 'unit')}` : ''}${typeof a.amountCents === 'number' ? ` · ${money(a.amountCents)} ${a.refundMethod === 'store_credit' ? 'store credit' : 'refund'}` : ''}${a.fulfillment === 'pickup' ? ' · truck pickup' : ''}`,
        'waiting',
      );
    case 'order.return':
      return say(
        `received return ${String(a.rmaNumber ?? '')}${typeof a.amountCents === 'number' ? ` · ${money(a.amountCents)} ${a.refundMethod === 'store_credit' ? 'store credit' : 'refunded'}` : ''}`,
        'muted',
      );
    case 'order.split':
      return a.toNumber
        ? say(
            `moved ${Array.isArray(a.lines) ? plural(a.lines.length, 'line') : 'lines'} to ${String(a.toNumber)}`,
          )
        : say(`split this order off ${String(a.fromNumber ?? 'another order')}`);
    case 'order.credit.move':
      return a.toNumber
        ? say(`moved ${money(a.amountCents)} to ${String(a.toNumber)}`)
        : say(`moved ${money(a.amountCents)} here from ${String(a.fromNumber ?? 'another order')}`);
    case 'order.exchange.create':
      return say(
        `created this exchange order${m.originalNumber ? ` from ${String(m.originalNumber)}` : ''}`,
      );
    case 'order.task.create':
      return say('added a task');
    case 'order.task.update':
      return say('updated a task');
    case 'order.attachment.add':
      return say('attached a file');
    case 'order.attachment.remove':
      return say('removed an attachment', 'muted');
    case 'order.share_link_created':
      return say('created a customer share link');
    default: {
      const word = row.action
        .replace(/^order\./, '')
        .replace(/[._]/g, ' ')
        .trim();
      const what = changes(b, a, names);
      return say(`${word}${what ? `: ${what}` : ''}`);
    }
  }
}
