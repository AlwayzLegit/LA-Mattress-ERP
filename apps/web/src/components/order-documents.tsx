'use client';

/**
 * Printable documents (PLAN-POS-OPERATIONS §11): the invoice / sales
 * order and the delivery ticket, both rendered from the API's one-call
 * `/v1/orders/:id/document` payload. Neutral template + tenant logo
 * slot; explicit black-on-white styling so the app theme never bleeds
 * into paper.
 */

import { TableWrap } from './ui';

export interface OrderDocumentPayload {
  business: {
    name: string;
    logoUrl: string | null;
    /** Settings → Branding accent (#rrggbb) — the invoice's brand color. */
    accentColor: string | null;
    invoiceHeaderNote: string | null;
    invoiceFooterNote: string | null;
  };
  location: { name: string; orderPrefix: string | null; addressJson: unknown } | null;
  customer: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    address: {
      line1: string | null;
      line2: string | null;
      city: string | null;
      region: string | null;
      postalCode: string | null;
    } | null;
  } | null;
  salespersonName: string | null;
  secondSalespersonName: string | null;
  /** §10: set on exchange orders — the Original Invoice #. */
  originalOrderNumber: string | null;
  scheduledDate: string | null;
  order: {
    id: string;
    number: string;
    /** A20 "Custom Order Information" rows, printed under the lines. */
    customInfoJson?: { label: string; value: string }[] | null;
    status: string;
    orderKind: string;
    fulfillmentType: string;
    subtotalCents: number;
    discountCents: number;
    orderDiscountCents: number;
    taxCents: number;
    totalCents: number;
    paidCents: number;
    balanceDueCents: number;
    creditDueCents: number;
    deliveryFeeCents: number;
    installFeeCents: number;
    otherFeeCents: number;
    otherFeeLabel: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    addressCity: string | null;
    addressRegion: string | null;
    addressPostalCode: string | null;
    addressPhone: string | null;
    deliveryInstructions: string | null;
    notes: string | null;
    lockedAt: string | null;
    createdAt: string;
    payments: {
      id: string;
      method: string;
      amountCents: number;
      status: string;
      createdAt: string;
      /** The register's "Reference / last 4 / approval #" entry (owner 2026-09-11: prints). */
      processorRef?: string | null;
    }[];
  };
  lines: {
    id: string;
    description: string;
    quantity: number;
    qtyReserved: number;
    qtyFulfilled: number;
    lineType: string;
    unitPriceCents: number;
    discountCents: number;
    totalCents: number;
    fulfillmentMethod: string | null;
    model: string | null;
    brand: string | null;
    bin: string | null;
    /** A20 line details — comment prints on every document; the rest on the truck's. */
    comment?: string | null;
    room?: string | null;
    pieces?: number | null;
    prepCodes?: string[] | null;
    comJson?: { supplied?: boolean; description?: string | null } | null;
    needsInstall?: boolean;
  }[];
  /**
   * Owner 2026-08-31: a split family prints ONE invoice — every piece's
   * lines under the base number, take-with lines marked, family money
   * combined. Null when the order stands alone.
   */
  familyInvoice: {
    numbers: string[];
    lines: (OrderDocumentPayload['lines'][number] & {
      pieceNumber: string;
      takenWith: boolean;
    })[];
    subtotalCents: number;
    discountCents: number;
    deliveryFeeCents: number;
    installFeeCents: number;
    otherFeeCents: number;
    taxCents: number;
    totalCents: number;
    paidCents: number;
    balanceDueCents: number;
  } | null;
}

export function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** STORIS-style single-letter fulfillment code for the line grid. */
const FULFILLMENT_CODES: Record<string, string> = {
  delivery: 'D',
  pickup: 'P',
  take_with: 'T',
  direct_ship: 'S',
};

/**
 * BA-0041: documents print payment methods with the same labels the
 * POS shows, not raw enum values.
 */
const TENDER_LABELS: Record<string, string> = {
  card: 'Credit card',
  cash: 'Cash',
  check: 'Check',
  paypal: 'PayPal',
  venmo: 'Venmo',
  zelle: 'Zelle',
  synchrony: 'Synchrony',
  acima: 'Acima',
  store_credit: 'Store credit',
};

export function tenderLabel(method: string): string {
  return TENDER_LABELS[method] ?? method.replace(/_/g, ' ');
}

/**
 * BA-0015 / P-011: fee lines that are NOT merchandise — the statutory
 * recycling fee and the $0 declined-foundation marker ride order lines
 * (lineType "custom"), but the totals box must show Merchandise the
 * same way the entry screen does: goods only, fees broken out.
 */
const isRecyclingLine = (l: { lineType: string; description: string }) =>
  l.lineType === 'custom' && /recycling/i.test(l.description);

/**
 * BA-0029: Code 39 barcode as inline SVG — no library, prints crisply.
 * Encodes 0-9 A-Z space - . $ / + %; returns null when the value has a
 * character outside the set. Each character is 9 elements (bars/spaces
 * alternating, starting with a bar); "1" marks a wide element (3 units).
 */
const CODE39: Record<string, string> = {
  '0': '000110100',
  '1': '100100001',
  '2': '001100001',
  '3': '101100000',
  '4': '000110001',
  '5': '100110000',
  '6': '001110000',
  '7': '000100101',
  '8': '100100100',
  '9': '001100100',
  A: '100001001',
  B: '001001001',
  C: '101001000',
  D: '000011001',
  E: '100011000',
  F: '001011000',
  G: '000001101',
  H: '100001100',
  I: '001001100',
  J: '000011100',
  K: '100000011',
  L: '001000011',
  M: '101000010',
  N: '000010011',
  O: '100010010',
  P: '001010010',
  Q: '000000111',
  R: '100000110',
  S: '001000110',
  T: '000010110',
  U: '110000001',
  V: '011000001',
  W: '111000000',
  X: '010010001',
  Y: '110010000',
  Z: '011010000',
  '-': '010000101',
  '.': '110000100',
  ' ': '011000100',
  '*': '010010100',
  $: '010101000',
  '/': '010100010',
  '+': '010001010',
  '%': '000101010',
};

export function Barcode39({
  value,
  height = 34,
  showText = true,
}: {
  value: string;
  height?: number;
  showText?: boolean;
}) {
  const text = `*${value.toUpperCase()}*`;
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  for (const ch of text) {
    const pat = CODE39[ch];
    if (!pat) return null;
    for (let i = 0; i < 9; i++) {
      const w = pat[i] === '1' ? 3 : 1;
      if (i % 2 === 0) bars.push({ x, w });
      x += w;
    }
    x += 1; // inter-character narrow gap
  }
  const width = x - 1;
  return (
    <div style={{ display: 'inline-block', textAlign: 'center' }}>
      <svg
        width={width * 1.4}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        shapeRendering="crispEdges"
        role="img"
        aria-label={value}
      >
        {bars.map((b, i) => (
          <rect key={i} x={b.x} y={0} width={b.w} height={height} fill="#000" />
        ))}
      </svg>
      {showText && (
        <div style={{ fontSize: 9, letterSpacing: '0.12em', fontFamily: 'monospace' }}>{value}</div>
      )}
    </div>
  );
}

function StoreAddress({ addressJson }: { addressJson: unknown }) {
  if (!addressJson || typeof addressJson !== 'object') return null;
  const a = addressJson as Record<string, unknown>;
  const s = (k: string) => (typeof a[k] === 'string' && a[k] ? (a[k] as string) : null);
  const cityLine = [s('city'), s('region') ?? s('state'), s('postalCode') ?? s('zip')]
    .filter(Boolean)
    .join(', ');
  return (
    <>
      {s('line1') && <div>{s('line1')}</div>}
      {s('line2') && <div>{s('line2')}</div>}
      {cityLine && <div>{cityLine}</div>}
      {s('phone') && <div>Ph. {s('phone')}</div>}
    </>
  );
}

const box: React.CSSProperties = { border: '1px solid #000', padding: '4px 8px' };
const label: React.CSSProperties = {
  fontSize: 9,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: '#333',
};
const cell: React.CSSProperties = {
  border: '1px solid #000',
  padding: '3px 6px',
  fontSize: 11,
  verticalAlign: 'top',
};
/** Print sheet: the cells draw their own black rules, so the wrap drops its chrome. */
const sheet: React.CSSProperties = { border: 'none', borderRadius: 0, background: 'transparent' };

/** Billing street block for SOLD TO (BA-0014: ZIP included). */
function BillingAddress({ doc }: { doc: OrderDocumentPayload }) {
  const a = doc.customer?.address;
  if (!a || (!a.line1 && !a.city)) return null;
  return (
    <>
      {a.line1 && <div>{a.line1}</div>}
      {a.line2 && <div>{a.line2}</div>}
      <div>{[a.city, a.region, a.postalCode].filter(Boolean).join(', ')}</div>
    </>
  );
}

function ShipTo({ doc }: { doc: OrderDocumentPayload }) {
  const o = doc.order;
  const hasAddress = o.addressLine1 || o.addressCity;
  const bill = doc.customer?.address;
  return (
    <>
      <div style={{ fontWeight: 700 }}>{doc.customer?.name ?? '—'}</div>
      {hasAddress ? (
        <>
          {o.addressLine1 && <div>{o.addressLine1}</div>}
          {o.addressLine2 && <div>{o.addressLine2}</div>}
          <div>
            {[o.addressCity, o.addressRegion, o.addressPostalCode].filter(Boolean).join(', ')}
          </div>
        </>
      ) : bill && (bill.line1 || bill.city) ? (
        // BA-0014: print the real billing address, ZIP included, instead
        // of a bare "Same as billing" pointer.
        <BillingAddress doc={doc} />
      ) : (
        <div style={{ color: '#333' }}>Same as billing</div>
      )}
      {(o.addressPhone ?? doc.customer?.phone) && (
        <div>Ph. {o.addressPhone ?? doc.customer?.phone}</div>
      )}
    </>
  );
}

/**
 * A20 line details for the warehouse and the truck: room, pieces per
 * unit, prep codes, installation, customer's own material, the comment.
 */
export function LineInstructions({
  l,
}: {
  l: {
    comment?: string | null;
    room?: string | null;
    pieces?: number | null;
    prepCodes?: string[] | null;
    comJson?: { supplied?: boolean; description?: string | null } | null;
    needsInstall?: boolean;
  };
}) {
  const bits = [
    l.room ? `Room: ${l.room}` : null,
    l.pieces && l.pieces > 1 ? `${l.pieces} pieces per unit` : null,
    l.prepCodes?.length ? `Prep: ${l.prepCodes.join(', ')}` : null,
    l.needsInstall ? 'INSTALL' : null,
    l.comJson?.supplied ? `COM${l.comJson.description ? `: ${l.comJson.description}` : ''}` : null,
  ].filter(Boolean);
  if (bits.length === 0 && !l.comment) return null;
  return (
    <div style={{ fontSize: 9 }} data-testid="doc-line-instructions">
      {bits.length > 0 && <div style={{ fontWeight: 700 }}>{bits.join(' · ')}</div>}
      {l.comment && <div style={{ fontStyle: 'italic' }}>{l.comment}</div>}
    </div>
  );
}

/**
 * §11 Invoice / Sales Order — modern clean layout (owner 2026-09-11):
 * tenant logo + brand accent, a balance callout the customer sees first,
 * Sold to / Ship to / Order details cards, a rule-only line grid and a
 * totals card. Same data as the STORIS replica it replaces (every field
 * of §11 and its amendments still prints); Letter paper, multi-page safe
 * (the grid header repeats, rows never split). The Exchange Order shares
 * the shell (title, Original Invoice #, Credit Due).
 */
/** LA Mattress logo navy (owner 2026-09-11) — the invoice color until Branding sets one. */
const DEFAULT_ACCENT = '#0f2057';
const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Brand accent from Settings → Branding, else the LA Mattress navy. */
export function invoiceAccent(hex: string | null | undefined): string {
  return hex && HEX_RE.test(hex) ? hex.toLowerCase() : DEFAULT_ACCENT;
}

function hexRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Light wash of the accent for notice bars (mixes toward white). */
function tint(hex: string, amount = 0.9): string {
  const [r, g, b] = hexRgb(hex);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/** Black or white text, whichever reads on the accent (WCAG luminance). */
export function onAccent(hex: string): string {
  const [r, g, b] = hexRgb(hex);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return lum > 0.4 ? '#111111' : '#ffffff';
}

const INVOICE_CSS = `
@page { size: letter; margin: 1in; }
.inv { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.inv table { border-collapse: collapse; width: 100%; }
.inv thead { display: table-header-group; }
.inv tr, .inv .inv-card { break-inside: avoid; page-break-inside: avoid; }
.inv .inv-lines tbody tr:nth-child(even) td { background: #f8f9fa; }
.inv .inv-num { font-variant-numeric: tabular-nums; }
@media print {
  .inv { padding: 0 !important; max-width: none !important; }
}
`;

const FONT = '-apple-system, "Segoe UI", Inter, Helvetica, Arial, sans-serif';
const MUTED = '#6b7280';
const RULE = '#e5e7eb';

const cardStyle: React.CSSProperties = {
  border: `1px solid ${RULE}`,
  borderRadius: 6,
  padding: '10px 12px',
  minWidth: 0,
};
const cardLabel: React.CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: MUTED,
  marginBottom: 4,
};
const th: React.CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  textAlign: 'left',
  padding: '6px 8px',
};
const td: React.CSSProperties = {
  padding: '7px 8px',
  borderBottom: `1px solid ${RULE}`,
  verticalAlign: 'top',
  fontSize: 11,
};

/** §11 Invoice / Sales Order. */
export function InvoiceDoc({ doc, printedAt }: { doc: OrderDocumentPayload; printedAt: Date }) {
  const o = doc.order;
  // Combined family invoice: base number up top, every piece's lines in
  // the grid (take-with marked), and the family's combined money.
  const fam = doc.familyInvoice;
  const docNumber = fam ? o.number.replace(/-[A-Z]$/, '') : o.number;
  const money = fam ?? o;
  const title =
    o.orderKind === 'exchange'
      ? 'Exchange Order'
      : o.orderKind === 'layaway'
        ? 'Layaway'
        : o.status === 'quote'
          ? 'Quote'
          : 'Sales Order';
  const totalDiscount = o.discountCents + o.orderDiscountCents;
  // BA-0015 / P-011: Merchandise on the invoice matches the entry screen
  // — goods only, with the recycling fee broken out on its own line
  // (CA requires the fee itemized on the receipt).
  const gridLines =
    fam?.lines ?? doc.lines.map((l) => ({ ...l, pieceNumber: o.number, takenWith: false }));
  const recyclingCents = gridLines.filter(isRecyclingLine).reduce((n, l) => n + l.totalCents, 0);
  const accent = invoiceAccent(doc.business.accentColor);
  const accentText = onAccent(accent);
  const creditDue = !fam && o.creditDueCents > 0;
  // The callout the customer reads first: what they still owe, what we
  // owe them (exchange), or that the order is settled.
  const callout = creditDue
    ? { label: 'Credit due', value: usd(o.creditDueCents) }
    : money.balanceDueCents > 0
      ? { label: 'Amount due', value: usd(money.balanceDueCents) }
      : { label: 'Paid in full', value: null };
  const payments = o.payments.filter((p) => p.status === 'succeeded');

  return (
    <div
      className="inv"
      data-testid="invoice-doc"
      style={{
        background: '#fff',
        color: '#111',
        fontFamily: FONT,
        fontSize: 11.5,
        lineHeight: 1.4,
        maxWidth: 800,
        margin: '0 auto',
        padding: 32,
      }}
    >
      <style>{INVOICE_CSS}</style>

      {/* Header: identity left, document right, accent rule beneath */}
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 24,
          alignItems: 'flex-start',
          paddingBottom: 14,
          borderBottom: `3px solid ${accent}`,
        }}
      >
        <div style={{ minWidth: 0 }}>
          {doc.business.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={doc.business.logoUrl}
              alt={doc.business.name}
              style={{ maxHeight: 56, maxWidth: 220, display: 'block', marginBottom: 6 }}
            />
          ) : (
            <div style={{ fontSize: 22, fontWeight: 700, color: accent, marginBottom: 4 }}>
              {doc.business.name}
            </div>
          )}
          {/* Owner 2026-09-11: the selling store's full address, no store name. */}
          <div style={{ fontSize: 11, color: '#374151' }}>
            <StoreAddress addressJson={doc.location?.addressJson} />
          </div>
        </div>
        <div style={{ textAlign: 'right', flex: 'none' }}>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em', color: accent }}>
            {title}
          </div>
          <div style={{ fontSize: 13, marginTop: 2 }} className="inv-num">
            <span style={{ color: MUTED }}>№</span>{' '}
            <strong data-testid="invoice-number">{docNumber}</strong>
          </div>
          {fam && (
            <div style={{ fontSize: 9.5, color: MUTED }}>Covers {fam.numbers.join(' + ')}</div>
          )}
          {doc.originalOrderNumber && (
            <div style={{ fontSize: 10.5, marginTop: 2 }}>
              <span style={{ color: MUTED }}>Original invoice</span>{' '}
              <strong>{doc.originalOrderNumber}</strong>
            </div>
          )}
          <div style={{ fontSize: 10.5, color: MUTED, marginTop: 6 }} className="inv-num">
            <div>
              Document date{' '}
              <span style={{ color: '#111' }}>{new Date(o.createdAt).toLocaleDateString()}</span>
            </div>
            <div>
              Scheduled <span style={{ color: '#111' }}>{doc.scheduledDate ?? '—'}</span>
            </div>
          </div>
          <div
            data-testid="invoice-callout"
            style={{
              display: 'inline-block',
              marginTop: 10,
              padding: callout.value ? '8px 14px' : '6px 12px',
              borderRadius: 6,
              background: callout.value ? accent : tint(accent, 0.85),
              color: callout.value ? accentText : '#111',
              textAlign: 'right',
            }}
          >
            <div
              style={{
                fontSize: 9.5,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                opacity: callout.value ? 0.85 : 1,
              }}
            >
              {callout.label}
            </div>
            {callout.value && (
              <div className="inv-num" style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.1 }}>
                {callout.value}
              </div>
            )}
          </div>
        </div>
      </header>

      {doc.business.invoiceHeaderNote && (
        <div
          style={{
            marginTop: 14,
            padding: '8px 12px',
            background: tint(accent, 0.9),
            borderLeft: `4px solid ${accent}`,
            borderRadius: 4,
            fontWeight: 600,
            fontSize: 11.5,
          }}
        >
          {doc.business.invoiceHeaderNote}
        </div>
      )}

      {/* Parties + order details */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 12,
          marginTop: 16,
        }}
      >
        <div className="inv-card" style={cardStyle}>
          <div style={cardLabel}>Sold to</div>
          <div style={{ fontWeight: 700 }}>{doc.customer?.name ?? '—'}</div>
          <BillingAddress doc={doc} />
          {doc.customer?.phone && <div>Ph. {doc.customer.phone}</div>}
          {doc.customer?.email && <div style={{ color: '#374151' }}>{doc.customer.email}</div>}
        </div>
        <div className="inv-card" style={cardStyle}>
          <div style={cardLabel}>Ship to</div>
          <ShipTo doc={doc} />
        </div>
        <div className="inv-card" style={cardStyle}>
          <div style={cardLabel}>Order details</div>
          <DetailRow label="Salesperson">
            {/* BA-0013: full names, not initials. */}
            {doc.salespersonName ?? '—'}
            {doc.secondSalespersonName ? ` / ${doc.secondSalespersonName}` : ''}
          </DetailRow>
          <DetailRow label="Fulfillment">
            <span style={{ textTransform: 'capitalize' }}>
              {o.fulfillmentType.replace(/_/g, ' ')}
            </span>
          </DetailRow>
          <DetailRow label="Terms">
            {money.balanceDueCents > 0 ? 'Balance due' : 'Paid in full'}
          </DetailRow>
          {/* BA-0030: no "Customer #" — there is no human-facing customer number. */}
        </div>
      </section>

      {o.notes && (
        <div className="inv-card" style={{ ...cardStyle, marginTop: 12 }}>
          <div style={cardLabel}>Notes</div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{o.notes}</div>
        </div>
      )}

      {/* Line grid — $0.00 lines print too (§11) */}
      <table className="inv-lines" style={{ marginTop: 18 }} data-testid="invoice-lines">
        <thead>
          <tr style={{ borderBottom: `2px solid ${accent}` }}>
            <th style={{ ...th, color: accent, width: 28 }}>#</th>
            <th style={{ ...th, color: accent }}>Item</th>
            <th
              style={{ ...th, color: accent, width: 34, textAlign: 'center' }}
              title="Fulfillment"
            >
              Ful.
            </th>
            <th style={{ ...th, color: accent, width: 44, textAlign: 'right' }}>Qty</th>
            <th style={{ ...th, color: accent, width: 84, textAlign: 'right' }}>Price</th>
            <th style={{ ...th, color: accent, width: 92, textAlign: 'right' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {gridLines.map((l, i) => {
            const meta = [l.model, l.brand].filter(Boolean).join(' · ');
            return (
              <tr key={l.id}>
                <td style={{ ...td, color: MUTED }} className="inv-num">
                  {i + 1}
                </td>
                <td style={td}>
                  <div style={{ fontWeight: 600 }}>{l.description}</div>
                  {(meta || l.takenWith || l.comJson?.supplied) && (
                    <div style={{ fontSize: 9.5, color: MUTED, marginTop: 1 }}>
                      {meta}
                      {l.takenWith && (
                        <span>
                          {meta ? ' · ' : ''}Taken with ({l.pieceNumber})
                        </span>
                      )}
                      {l.comJson?.supplied && (
                        <span>{meta || l.takenWith ? ' · ' : ''}Customer&apos;s own material</span>
                      )}
                    </div>
                  )}
                  {l.comment && (
                    <div
                      style={{ fontSize: 9.5, fontStyle: 'italic', marginTop: 1 }}
                      data-testid="doc-line-comment"
                    >
                      {l.comment}
                    </div>
                  )}
                </td>
                <td style={{ ...td, textAlign: 'center', color: MUTED }}>
                  {l.takenWith
                    ? 'T'
                    : (FULFILLMENT_CODES[l.fulfillmentMethod ?? o.fulfillmentType] ?? '')}
                </td>
                <td style={{ ...td, textAlign: 'right' }} className="inv-num">
                  {l.quantity}
                </td>
                <td style={{ ...td, textAlign: 'right' }} className="inv-num">
                  {usd(l.unitPriceCents)}
                </td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 600 }} className="inv-num">
                  {usd(l.totalCents)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {(o.customInfoJson ?? []).length > 0 && (
        <div
          className="inv-card"
          style={{ ...cardStyle, marginTop: 12 }}
          data-testid="doc-custom-info"
        >
          <div style={cardLabel}>Custom order information</div>
          {(o.customInfoJson ?? []).map((row, i) => (
            <div key={i} style={{ fontSize: 10.5 }}>
              <strong>{row.label}</strong>
              {row.label && row.value ? ': ' : ''}
              {row.value}
            </div>
          ))}
        </div>
      )}

      {/* Payments + totals */}
      <section style={{ display: 'flex', gap: 24, marginTop: 18, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {payments.length > 0 && (
            <div className="inv-card" style={cardStyle} data-testid="invoice-payments">
              <div style={cardLabel}>Payments</div>
              <table>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td style={{ padding: '3px 0', fontSize: 11 }}>
                        {tenderLabel(p.method)}
                        {p.processorRef && (
                          <span
                            style={{ color: MUTED, marginLeft: 6 }}
                            className="inv-num"
                            data-testid="invoice-payment-ref"
                          >
                            {paymentRef(p.processorRef)}
                          </span>
                        )}
                      </td>
                      <td
                        style={{ padding: '3px 8px', fontSize: 11, color: MUTED }}
                        className="inv-num"
                      >
                        {new Date(p.createdAt).toLocaleDateString()}
                      </td>
                      <td
                        style={{ padding: '3px 0', fontSize: 11, textAlign: 'right' }}
                        className="inv-num"
                      >
                        {usd(p.amountCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="inv-card" style={{ width: 280, flex: 'none' }} data-testid="invoice-totals">
          <table>
            <tbody>
              <TotalRow label="Merchandise" value={usd(money.subtotalCents - recyclingCents)} />
              {recyclingCents > 0 && <TotalRow label="Recycling" value={usd(recyclingCents)} />}
              {(fam ? fam.discountCents : totalDiscount) > 0 && (
                <TotalRow
                  label="Discounts"
                  value={`-${usd(fam ? fam.discountCents : totalDiscount)}`}
                />
              )}
              {money.installFeeCents > 0 && (
                <TotalRow label="Installation" value={usd(money.installFeeCents)} />
              )}
              {money.deliveryFeeCents > 0 && (
                <TotalRow label="Delivery" value={usd(money.deliveryFeeCents)} />
              )}
              {money.otherFeeCents > 0 && (
                <TotalRow label={o.otherFeeLabel ?? 'Other'} value={usd(money.otherFeeCents)} />
              )}
              <TotalRow label="Tax" value={usd(money.taxCents)} />
              <TotalRow label={`Total ${title}`} value={usd(money.totalCents)} bold rule />
              <TotalRow label="Amount paid" value={usd(money.paidCents)} />
              {creditDue ? (
                <TotalRow
                  label="Credit due"
                  value={usd(o.creditDueCents)}
                  bold
                  highlight={{ background: accent, color: accentText }}
                />
              ) : (
                <TotalRow
                  label="Amount due"
                  value={usd(money.balanceDueCents)}
                  bold
                  highlight={{ background: accent, color: accentText }}
                />
              )}
            </tbody>
          </table>
        </div>
      </section>

      <footer
        style={{
          marginTop: 22,
          paddingTop: 10,
          borderTop: `1px solid ${RULE}`,
          fontSize: 10,
          color: '#374151',
        }}
      >
        {doc.business.invoiceFooterNote && (
          <div style={{ whiteSpace: 'pre-wrap' }}>{doc.business.invoiceFooterNote}</div>
        )}
        <div style={{ marginTop: doc.business.invoiceFooterNote ? 6 : 0, color: MUTED }}>
          {title} {docNumber} · Printed {printedAt.toLocaleString()}
        </div>
      </footer>
    </div>
  );
}

/**
 * The register's reference field as it should read on paper: a bare
 * last-4 becomes "•••• 4242"; anything else (approval #, check #) prints
 * as entered.
 */
export function paymentRef(ref: string): string {
  const t = ref.trim();
  return /^\d{4}$/.test(t) ? `•••• ${t}` : t;
}

function DetailRow({ label: l, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 11 }}>
      <span style={{ color: MUTED, width: 78, flex: 'none' }}>{l}</span>
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  );
}

function TotalRow({
  label: l,
  value,
  bold,
  rule,
  highlight,
}: {
  label: string;
  value: string;
  bold?: boolean;
  /** A rule above the row (the order total). */
  rule?: boolean;
  /** Filled row (the amount / credit due). */
  highlight?: { background: string; color: string };
}) {
  const base: React.CSSProperties = {
    padding: highlight ? '8px 10px' : '3px 10px',
    fontWeight: bold ? 700 : 400,
    fontSize: highlight ? 13 : 11.5,
    borderTop: rule ? `1px solid ${RULE}` : undefined,
    background: highlight?.background,
    color: highlight?.color,
  };
  return (
    <tr>
      <td style={base}>{l}</td>
      <td style={{ ...base, textAlign: 'right' }} className="inv-num">
        {value}
      </td>
    </tr>
  );
}

/** §11 Delivery Ticket: lines, delivery notes, route/date, signature line. */
export function DeliveryTicketDoc({
  doc,
  routeDate,
  routePosition,
  flag,
}: {
  doc: OrderDocumentPayload;
  /** Trip date shown on the ticket; defaults to the order's scheduled date. */
  routeDate?: string | null;
  routePosition?: number | null;
  /** Batch print: why this order is not deliverable today (§7 flag). */
  flag?: string | null;
}) {
  const o = doc.order;
  return (
    <div
      style={{
        background: '#fff',
        color: '#000',
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontSize: 12,
        maxWidth: 780,
        margin: '0 auto',
        padding: 24,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Delivery Ticket</div>
          <div style={{ fontSize: 11 }}>
            {doc.business.name}
            {doc.location ? ` — ${doc.location.name}` : ''}
          </div>
        </div>
        <div style={{ width: 220 }}>
          <div style={{ ...box, textAlign: 'center', marginBottom: 6 }}>
            <div style={label}>Order #</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{o.number}</div>
            {/* BA-0029: scannable order-number barcode. */}
            <Barcode39 value={o.number} height={30} showText={false} />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <div style={{ ...box, flex: 1, textAlign: 'center' }}>
              <div style={label}>Date</div>
              <div>{routeDate ?? doc.scheduledDate ?? '—'}</div>
            </div>
            <div style={{ ...box, flex: 1, textAlign: 'center' }}>
              <div style={label}>Stop</div>
              <div>{routePosition ?? '—'}</div>
            </div>
          </div>
        </div>
      </div>

      {flag && (
        <div
          style={{
            border: '2px solid #000',
            padding: 8,
            marginTop: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
          }}
        >
          ⚠ Not ready: {flag}
        </div>
      )}

      <div style={{ ...box, marginTop: 10 }}>
        <div style={label}>Deliver To</div>
        <ShipTo doc={doc} />
      </div>

      <TableWrap style={{ ...sheet, marginTop: 10 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Qty', 'Model', 'Description'].map((h) => (
                <th key={h} style={{ ...cell, ...label, textAlign: 'left' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {doc.lines
              // BA-0028: fee lines (recycling, declined-foundation markers)
              // are not goods to load — same rule as the pick list. Take-with
              // lines already left with the customer.
              .filter(
                (l) =>
                  l.lineType !== 'custom' &&
                  (l.fulfillmentMethod ?? o.fulfillmentType) !== 'take_with',
              )
              .map((l) => (
                <tr key={l.id}>
                  <td style={{ ...cell, width: 40, textAlign: 'right' }}>{l.quantity}</td>
                  <td style={{ ...cell, width: 140 }}>{l.model ?? '—'}</td>
                  <td style={cell}>
                    {l.description}
                    <LineInstructions l={l} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </TableWrap>

      {(o.deliveryInstructions ?? o.notes) && (
        <div style={{ ...box, marginTop: 10, minHeight: 36 }}>
          <div style={label}>Delivery Notes</div>
          {o.deliveryInstructions ?? o.notes}
        </div>
      )}

      {o.balanceDueCents > 0 && (
        <div style={{ marginTop: 10, fontWeight: 700 }}>
          Collect on delivery: {usd(o.balanceDueCents)}
        </div>
      )}

      <div style={{ marginTop: 48, display: 'flex', gap: 32 }}>
        <div style={{ flex: 2 }}>
          <div style={{ borderTop: '1px solid #000', paddingTop: 4, fontSize: 10 }}>
            Customer signature
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ borderTop: '1px solid #000', paddingTop: 4, fontSize: 10 }}>Date</div>
        </div>
      </div>
    </div>
  );
}
