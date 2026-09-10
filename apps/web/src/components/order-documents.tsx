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
      {/* Header: logo + store block | header note | order # + date boxes */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          {doc.business.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={doc.business.logoUrl}
              alt={doc.business.name}
              style={{ maxHeight: 48, maxWidth: 200, marginBottom: 4 }}
            />
          ) : (
            <div style={{ fontSize: 18, fontWeight: 700 }}>{doc.business.name}</div>
          )}
          <div style={{ fontSize: 11 }}>
            {doc.location && <div style={{ fontWeight: 700 }}>{doc.location.name}</div>}
            <StoreAddress addressJson={doc.location?.addressJson} />
          </div>
        </div>
        <div style={{ flex: 1, textAlign: 'center', paddingTop: 6 }}>
          {doc.business.invoiceHeaderNote && (
            <div style={{ fontWeight: 700, fontSize: 12, border: '1px solid #000', padding: 6 }}>
              {doc.business.invoiceHeaderNote}
            </div>
          )}
        </div>
        <div style={{ width: 200 }}>
          <div style={{ ...box, textAlign: 'center', marginBottom: 6 }}>
            <div style={label}>{title} #</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{docNumber}</div>
            {fam && (
              <div style={{ fontSize: 9, marginTop: 2 }}>Covers {fam.numbers.join(' + ')}</div>
            )}
          </div>
          {doc.originalOrderNumber && (
            <div style={{ ...box, textAlign: 'center', marginBottom: 6 }}>
              <div style={label}>Original Invoice #</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{doc.originalOrderNumber}</div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <div style={{ ...box, flex: 1, textAlign: 'center' }}>
              <div style={label}>Scheduled Date</div>
              <div>{doc.scheduledDate ?? '—'}</div>
            </div>
            <div style={{ ...box, flex: 1, textAlign: 'center' }}>
              <div style={label}>Document Date</div>
              <div>{new Date(o.createdAt).toLocaleDateString()}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Sold To / Ship To */}
      <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
        <div style={{ ...box, flex: 1, minHeight: 70 }}>
          <div style={label}>Sold To</div>
          <div style={{ fontWeight: 700 }}>{doc.customer?.name ?? '—'}</div>
          <BillingAddress doc={doc} />
          {doc.customer?.phone && <div>Ph. {doc.customer.phone}</div>}
          {doc.customer?.email && <div>{doc.customer.email}</div>}
        </div>
        <div style={{ ...box, flex: 1, minHeight: 70 }}>
          <div style={label}>Ship To</div>
          <ShipTo doc={doc} />
        </div>
      </div>

      {/* Info strip */}
      <TableWrap style={{ ...sheet, marginTop: 10 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {/* BA-0030: no "Customer #" — we have no human-facing customer
                  number, and a fragment of the internal id helps nobody. */}
              {['Customer Ph.', 'Terms', 'Salesperson', 'Store'].map((h) => (
                <th key={h} style={{ ...cell, ...label, textAlign: 'left' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={cell}>{doc.customer?.phone ?? '—'}</td>
              <td style={cell}>{money.balanceDueCents > 0 ? 'Balance due' : 'Paid in full'}</td>
              <td style={cell}>
                {/* BA-0013: full names, not initials. */}
                {doc.salespersonName ?? '—'}
                {doc.secondSalespersonName ? ` / ${doc.secondSalespersonName}` : ''}
              </td>
              <td style={cell}>
                {doc.location?.orderPrefix ?? ''} {doc.location?.name ?? '—'}
              </td>
            </tr>
          </tbody>
        </table>
      </TableWrap>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10 }}>
        <div>
          Fulfillment: <strong>{o.fulfillmentType.replace(/_/g, ' ')}</strong>
        </div>
        <div>Printed {printedAt.toLocaleString()}</div>
      </div>
      {o.notes && (
        <div style={{ ...box, marginTop: 6, minHeight: 28 }}>
          <div style={label}>Notes</div>
          {o.notes}
        </div>
      )}

      {/* Line grid — $0.00 lines print too (§11) */}
      <TableWrap style={{ ...sheet, marginTop: 10 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Ln#', 'F', 'Model', 'Brand', 'Description', 'Qty', 'Price', 'Amount'].map((h) => (
                <th key={h} style={{ ...cell, ...label, textAlign: 'left' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {gridLines.map((l, i) => (
              <tr key={l.id}>
                <td style={cell}>{i + 1}</td>
                <td style={cell}>
                  {l.takenWith
                    ? 'T'
                    : (FULFILLMENT_CODES[l.fulfillmentMethod ?? o.fulfillmentType] ?? '')}
                </td>
                <td style={cell}>{l.model ?? '—'}</td>
                <td style={cell}>{l.brand ?? '—'}</td>
                <td style={cell}>
                  {l.description}
                  {l.takenWith && (
                    <span style={{ fontSize: 9 }}> — TAKEN WITH ({l.pieceNumber})</span>
                  )}
                  {l.comJson?.supplied && (
                    <span style={{ fontSize: 9 }}> — CUSTOMER&apos;S OWN MATERIAL</span>
                  )}
                  {l.comment && (
                    <div
                      style={{ fontSize: 9, fontStyle: 'italic' }}
                      data-testid="doc-line-comment"
                    >
                      {l.comment}
                    </div>
                  )}
                </td>
                <td style={{ ...cell, textAlign: 'right' }}>{l.quantity}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{usd(l.unitPriceCents)}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{usd(l.totalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>

      {(o.customInfoJson ?? []).length > 0 && (
        <div style={{ ...box, marginTop: 8 }} data-testid="doc-custom-info">
          <div style={label}>Custom Order Information</div>
          {(o.customInfoJson ?? []).map((row, i) => (
            <div key={i} style={{ fontSize: 10 }}>
              <strong>{row.label}</strong>
              {row.label && row.value ? ': ' : ''}
              {row.value}
            </div>
          ))}
        </div>
      )}

      {/* Totals + payments */}
      <div style={{ display: 'flex', gap: 16, marginTop: 12 }}>
        <div style={{ flex: 1 }}>
          {o.payments.length > 0 && (
            <TableWrap style={sheet}>
              <table style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Payment', 'Date', 'Amount'].map((h) => (
                      <th key={h} style={{ ...cell, ...label, textAlign: 'left' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {o.payments
                    .filter((p) => p.status === 'succeeded')
                    .map((p) => (
                      <tr key={p.id}>
                        <td style={cell}>{tenderLabel(p.method)}</td>
                        <td style={cell}>{new Date(p.createdAt).toLocaleDateString()}</td>
                        <td style={{ ...cell, textAlign: 'right' }}>{usd(p.amountCents)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </div>
        <TableWrap style={{ ...sheet, width: 260, flex: 'none' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
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
              <TotalRow label={`Total ${title}`} value={usd(money.totalCents)} bold />
              <TotalRow label="Amount Paid" value={usd(money.paidCents)} />
              {!fam && o.creditDueCents > 0 ? (
                <TotalRow label="Credit Due" value={usd(o.creditDueCents)} bold boxed />
              ) : (
                <TotalRow label="Amount Due" value={usd(money.balanceDueCents)} bold boxed />
              )}
            </tbody>
          </table>
        </TableWrap>
      </div>

      {doc.business.invoiceFooterNote && (
        <div
          style={{
            marginTop: 'var(--space-4)',
            fontSize: 10,
            borderTop: '1px solid #000',
            paddingTop: 8,
          }}
        >
          {doc.business.invoiceFooterNote}
        </div>
      )}
    </div>
  );
}

function TotalRow({
  label: l,
  value,
  bold,
  boxed,
}: {
  label: string;
  value: string;
  bold?: boolean;
  boxed?: boolean;
}) {
  return (
    <tr>
      <td style={{ padding: '2px 8px', fontWeight: bold ? 700 : 400 }}>{l}</td>
      <td
        style={{
          padding: '2px 8px',
          textAlign: 'right',
          fontWeight: bold ? 700 : 400,
          border: boxed ? '2px solid #000' : undefined,
        }}
      >
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
