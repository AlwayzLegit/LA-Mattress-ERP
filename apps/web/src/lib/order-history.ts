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
  shop_pay: 'Shop Pay',
  synchrony: 'Synchrony',
  acima: 'Acima',
  vds: 'VDS',
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
  splitBps: 'bonus split',
  taxRateBps: 'tax rate',
  depositRequiredCents: 'deposit due',
  customerId: 'customer',
  // Owner 2026-11-19: "make it more detailed so we don't need to
  // investigate" — every field Order details can save gets a name.
  orderKind: 'order type',
  pickupLocationId: 'pickup store',
  stockLocationId: 'stock from',
  deliveryStatus: 'delivery status',
  deliveryInstructions: 'delivery instructions',
  internalNotes: 'internal notes',
  exceptionNotes: 'exception notes',
  marketingCode: 'marketing code',
  marketingCode2: 'marketing code 2',
  orderSource: 'order source',
  paymentTerminal: 'payment terminal',
  addressLine1: 'delivery address',
  addressLine2: 'apt / unit',
  addressCity: 'delivery city',
  addressRegion: 'delivery state',
  addressPostalCode: 'delivery ZIP',
  addressPhone: 'delivery phone',
  billingAddressJson: 'billing address',
  customInfoJson: 'custom info',
  tradeDesignerJson: 'trade designer',
  deliveryFeeCents: 'delivery fee',
  installFeeCents: 'install fee',
  otherFeeCents: 'other fee',
  otherFeeLabel: 'other fee name',
  orderDiscountCents: 'order discount',
  asIsItemId: 'As-Is piece',
  lineType: 'line type',
  assigneeMembershipId: 'assigned to',
  dueAt: 'due',
  priority: 'priority',
  title: 'title',
};

/** Free text shows in quotes, cut to a readable length. */
const TEXT_FIELDS = new Set([
  'notes',
  'internalNotes',
  'exceptionNotes',
  'deliveryInstructions',
  'description',
  'title',
]);

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

/** "1 Main St, Apt 2, Los Angeles, CA 90004" or "key: value, …" for a JSON field. */
function objectText(v: Record<string, unknown>, names: Record<string, string>): string {
  const str = (k: string) => (typeof v[k] === 'string' && (v[k] as string).trim()) || '';
  const line1 = str('line1') || str('address1') || str('street');
  if (line1) {
    const region = [str('region') || str('state'), str('postalCode') || str('zip')]
      .filter(Boolean)
      .join(' ');
    return [line1, str('line2') || str('address2'), str('city'), region].filter(Boolean).join(', ');
  }
  const parts = Object.entries(v)
    .filter(([, x]) => x != null && x !== '' && typeof x !== 'object')
    .map(([k, x]) => `${humanise(k)}: ${value(k, x, names)}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

/** One field value, readable: money, names for ids, dates, labels. */
function value(key: string, v: unknown, names: Record<string, string>): string {
  if (v == null || v === '') return 'none';
  if (Array.isArray(v)) return v.length === 0 ? 'none' : `${v.length} entries`;
  if (typeof v === 'object') return objectText(v as Record<string, unknown>, names);
  if (typeof v === 'string' && TEXT_FIELDS.has(key)) {
    const t = v.replace(/\s+/g, ' ').trim();
    return `“${t.length > 80 ? `${t.slice(0, 79)}…` : t}”`;
  }
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
  return String(v);
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
      (!/Id$/.test(k) || k in FIELD || named(after[k] ?? before[k], names)) &&
      JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null),
  );
  return keys
    .map((k) => {
      const label = FIELD[k] ?? humanise(k);
      return k in before
        ? `${label} ${value(k, before[k], names)} → ${value(k, after[k], names)}`
        : `${label} ${value(k, after[k], names)}`;
    })
    .join(', ');
}

function named(v: unknown, names: Record<string, string>): boolean {
  return typeof v === 'string' && !!names[v.toLowerCase()];
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
  // The line id rides in "before" only; "after" carries lineId: null, so a
  // spread of before and after lost the product name ("changed an item").
  const lineOf = () =>
    lineName({ variantId: b.variantId ?? a.variantId, lineId: b.lineId ?? a.lineId });
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
      const what = changes(b, a, names, ['lineId', 'variantId']);
      const name = lineOf();
      return say(what ? `changed ${name}: ${what}` : `edited ${name}`);
    }
    case 'order.line.line_type':
      return say(
        `changed ${lineOf()} to ${LINE_TYPE[String(a.lineType)] ?? String(a.lineType ?? '').replace(/_/g, ' ')}`,
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
      // Entries before 2026-10-13 saved only status/total as "before" and
      // every field the screen sent as "after" — read those as "set X to Y"
      // and drop what the screen always sends (order kind, updated at).
      const legacy = Object.keys(b).every((k) => k === 'status' || k === 'totalCents');
      const after = Object.fromEntries(Object.entries(a).filter(([k]) => k in b || legacy));
      const before = Object.fromEntries(Object.entries(b).filter(([k]) => k in after));
      const what = changes(before, after, names, ['updatedAt', ...(legacy ? ['orderKind'] : [])]);
      // Owner 2026-11-19 (WE-10091): a Save that moved nothing read as
      // "updated the order" and sent the owner looking for a change.
      return what
        ? say(`updated the order: ${what}`)
        : say('saved Order details with no changes', 'muted');
    }
    case 'order.fee_charged': {
      const fee = `${String(a.label ?? 'a fee')} ${money(a.amountCents)}`.trim();
      return say(
        typeof a.feeOrderNumber === 'string'
          ? `charged ${fee} on ${a.feeOrderNumber} (this order was closed)`
          : `charged ${fee}`,
      );
    }
    case 'order.selling_store.correct':
      return say(
        `moved the sale from ${String(b.locationName ?? 'one store')} to ${String(a.locationName ?? 'another')}${a.reason ? ` — ${String(a.reason)}` : ''}`,
      );
    case 'order.salesperson.correct': {
      const what = changes(b, a, names);
      const why = typeof m.reason === 'string' && m.reason.trim() ? ` — ${m.reason.trim()}` : '';
      return say(`corrected the salespeople${what ? `: ${what}` : ''}${why}`);
    }
    case 'order.lock':
      return say(
        `printed the delivery ticket${typeof m.copyNumber === 'number' && m.copyNumber > 1 ? ` (copy ${m.copyNumber})` : ''} — order locked`,
        'scheduled',
      );
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
    case 'order.reserve': {
      const n = typeof a.reserved === 'number' ? a.reserved : null;
      const short = typeof a.short === 'number' && a.short > 0 ? `, ${a.short} still short` : '';
      return say(
        n != null ? `reserved ${plural(n, 'unit')} of stock${short}` : 'reserved stock',
        'scheduled',
      );
    }
    case 'order.release':
      return say(
        typeof a.released === 'number'
          ? `released ${plural(a.released, 'reserved unit')}`
          : 'released the reserved stock',
        'waiting',
      );
    case 'order.auto_stock_release':
      return { text: 'Reserved stock was released automatically', who, tone: 'waiting' };
    case 'order.allocate_pending':
      return { text: 'A line is short of stock at its ship-from store', who, tone: 'waiting' };
    case 'order.price_adjustment':
      return say(
        `adjusted the price by ${money(a.amountCents)}${a.reason ? ` — ${String(a.reason)}` : ''}`,
        'waiting',
      );
    case 'order.note.add':
      return say(
        typeof a.preview === 'string' && a.preview.trim()
          ? `added a note: ${value('notes', a.preview, names)}`
          : 'added a note',
      );
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
    case 'order.task.create': {
      const parts = [
        typeof a.title === 'string'
          ? `added a task ${value('title', a.title, names)}`
          : 'added a task',
        named(a.assigneeMembershipId, names) ? `for ${item(a.assigneeMembershipId, names)}` : '',
        typeof a.dueAt === 'string' ? `due ${a.dueAt.slice(0, 10)}` : '',
      ].filter(Boolean);
      return say(parts.join(' '));
    }
    case 'order.task.update': {
      const title = String(b.title ?? m.taskTitle ?? a.title ?? '').trim();
      const what = changes(b, a, names, ['taskId']);
      const task = title ? `task ${value('title', title, names)}` : 'a task';
      return say(what ? `updated ${task}: ${what}` : `updated ${task}`);
    }
    case 'order.attachment.add':
      return say(typeof a.name === 'string' ? `attached ${a.name}` : 'attached a file');
    case 'order.attachment.remove':
      return say(
        typeof b.name === 'string' ? `removed the attachment ${b.name}` : 'removed an attachment',
        'muted',
      );
    case 'delivery.ticket_flags': {
      const list = Array.isArray(m.transitions) ? (m.transitions as Record<string, unknown>[]) : [];
      const FLAG: Record<string, string> = { P: 'printed', R: 'needs a reprint' };
      const flag = (f: unknown) => (typeof f === 'string' && FLAG[f]) || 'not printed';
      const parts = list.map((t) => {
        const what = t.record === 'header' ? 'ticket' : item(t.record, names);
        return `${what} ${String(t.date ?? '')}: ${flag(t.from)} → ${flag(t.to)}`;
      });
      const why = typeof m.reason === 'string' ? ` (${m.reason.replace(/_/g, ' ')})` : '';
      return say(
        parts.length > 0
          ? `updated the delivery ticket flags${why}: ${parts.join('; ')}`
          : `updated the delivery ticket flags${why}`,
        'scheduled',
      );
    }
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
