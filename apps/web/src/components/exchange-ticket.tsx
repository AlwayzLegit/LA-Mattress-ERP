import { formatPhone } from '@jetnine/shared';
import {
  DOC_THEME,
  DetailRow,
  StoreAddress,
  TotalRow,
  invoiceAccent,
  onAccent,
  paymentLabel,
  paymentRef,
  tint,
  usd,
  type OrderDocumentPayload,
} from './order-documents';

/**
 * Exchange Ticket (owner 2026-11-05: "make it more like our invoice with
 * logo and design colors … add dates and any other information").
 *
 * Same shell as the §11 invoice — tenant logo, brand accent, the amount
 * callout the customer reads first, cards, a rule-only grid — over the
 * three documents an exchange is made of: the container (number, status,
 * fee, tender, dates), the return leg (RMA, lines with reasons, who took
 * it, how the goods come back, authorized / picked-up dates) and the
 * replacement order (lines with model and price, salesperson,
 * fulfillment, scheduled date, payments, full totals with tax).
 */

export interface ExchangeTicketExchange {
  id: string;
  number: string;
  status: string;
  evenExchange: boolean;
  restockingFeeCents: number;
  returnId: string;
  rmaNumber: string | null;
  returnStatus: string | null;
  returnCents: number;
  saleOrderId: string;
  saleOrderNumber: string | null;
  saleOrderStatus: string | null;
  saleTotalCents: number;
  originalOrderNumber: string | null;
  referencedOrderNumber: string | null;
  customerName: string | null;
  createdAt: string;
  completedAt: string | null;
  splitAt: string | null;
  notes: string | null;
  returnSalespersonName: string | null;
  fulfillment: string;
  refundTender: string;
  ticketPrintCount: number;
  settlement: {
    returnCents: number;
    restockingFeeCents: number;
    creditCents: number;
    saleTotalCents: number;
    salePaidCents: number;
    saleBalanceDueCents: number;
  };
}

export interface ExchangeTicketReturn {
  rmaNumber: string;
  status: string;
  fulfillment: string;
  refundMethod: string;
  amountCents: number;
  reason: string | null;
  restockingFeeCents: number;
  pickupFeeCents: number;
  pickupDate: string | null;
  authorizedAt: string;
  goodsReceivedAt: string | null;
  completedAt: string | null;
  orderNumber: string | null;
  orderDate: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostalCode: string | null;
  locationName: string | null;
  salespersonName: string | null;
  businessName: string | null;
  linesTotalCents: number;
  pickup: {
    scheduledDate: string;
    windowStart: string | null;
    windowEnd: string | null;
    status: string;
    contactStatus: string | null;
  } | null;
  lines: {
    id: string;
    description: string | null;
    quantity: number;
    perUnitCents: number;
    reasonCode: string | null;
    reason: string | null;
  }[];
}

const { FONT, MUTED, RULE, cardStyle, cardLabel, th, td } = DOC_THEME;

const STATUS: Record<string, string> = {
  open: 'Open',
  on_hold: 'On hold — awaiting approval',
  completed: 'Completed',
  split: 'Split into separate documents',
  cancelled: 'Cancelled',
};
const RETURN_STATUS: Record<string, string> = {
  authorized: 'Authorized — goods not back yet',
  completed: 'Goods received',
  cancelled: 'Cancelled',
};
const ORDER_STATUS: Record<string, string> = {
  draft: 'Cart',
  quote: 'Quote',
  confirmed: 'Confirmed',
  scheduled: 'Scheduled',
  partially_fulfilled: 'Partially delivered',
  fulfilled: 'Delivered',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
const TENDER: Record<string, string> = {
  store_credit: 'store credit on account',
  original: 'original form of payment',
  cash: 'cash',
  check: 'check',
};

const humanize = (s: string | null | undefined, map: Record<string, string>) =>
  s ? (map[s] ?? s.replace(/_/g, ' ')) : '—';
const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString() : null;
const fmtDay = (d: string | null | undefined) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString() : null;
const clock = (t: string | null) => (t ? t.slice(0, 5) : '');

export function ExchangeTicketDoc({
  exchange: x,
  ret,
  sale,
  printedAt,
}: {
  exchange: ExchangeTicketExchange;
  ret: ExchangeTicketReturn | null;
  sale: OrderDocumentPayload | null;
  printedAt: Date;
}) {
  const accent = invoiceAccent(sale?.business.accentColor);
  const accentText = onAccent(accent);
  const businessName = sale?.business.name ?? ret?.businessName ?? '';
  const storeName = sale?.location?.name ?? ret?.locationName ?? null;
  const s = x.settlement;
  // Settled = the credit has been applied to the replacement: the return
  // is completed (goods received, or a dropped-off pre-cutover return
  // written as completed) or the whole exchange is. Reading only the
  // exchange status left a pickup exchange whose goods were back but
  // whose replacement was not yet delivered counting the store-credit
  // tender as a second credit and printing a refund (owner 2026-11-12).
  const settled =
    x.status === 'completed' || x.returnStatus === 'completed' || ret?.status === 'completed';
  const o = sale?.order ?? null;

  // What the customer still owes (or is owed) once the return credit is
  // netted against the replacement. Before settlement the credit is not a
  // tender on the replacement yet (the order nets it as a pending credit),
  // so it is subtracted here; after settlement it has been applied as a
  // store-credit payment and the replacement's own balance is the truth.
  // Tenders exclude that store-credit row so "Paid on replacement" never
  // counts the credit a second time.
  const tenderPaidCents = o
    ? o.payments
        .filter((p) => p.status === 'succeeded' && p.method !== 'store_credit')
        .reduce((n, p) => n + p.amountCents, 0)
    : settled
      ? Math.max(0, s.salePaidCents - s.creditCents)
      : s.salePaidCents;
  const netRaw = settled
    ? s.saleBalanceDueCents
    : s.saleTotalCents - s.creditCents - tenderPaidCents;
  const refundCents = settled ? 0 : Math.max(0, -netRaw);
  const balanceCents = Math.max(0, netRaw);
  const callout =
    balanceCents > 0
      ? { label: 'Balance due', value: usd(balanceCents) }
      : refundCents > 0
        ? { label: `Refund due · ${humanize(x.refundTender, TENDER)}`, value: usd(refundCents) }
        : { label: settled ? 'Settled — nothing due' : 'Even — nothing due', value: null };

  const payments = (o?.payments ?? []).filter((p) => p.status === 'succeeded');
  const goodsBack = ret?.goodsReceivedAt ?? ret?.completedAt ?? null;
  const pickupLine = ret?.pickup
    ? `${fmtDay(ret.pickup.scheduledDate)}${
        ret.pickup.windowStart
          ? ` ${clock(ret.pickup.windowStart)}–${clock(ret.pickup.windowEnd)}`
          : ''
      } · ${ret.pickup.status.replace(/_/g, ' ')}`
    : ret?.pickupDate
      ? `${fmtDay(ret.pickupDate)} · to be scheduled`
      : null;
  const replacementWhen = sale?.scheduledDate ?? o?.requestedDate ?? null;
  const returnTakenBy = x.returnSalespersonName ?? ret?.salespersonName ?? null;
  const originalNumber = x.originalOrderNumber ?? ret?.orderNumber ?? x.referencedOrderNumber;
  // Pre-cutover (dispatcher 2026-11-06): the original was written in
  // STORIS, so there is no order on file — the ticket names the system
  // the number came from instead of a date it cannot know.
  const preCutover = !x.originalOrderNumber && !ret?.orderNumber && !!x.referencedOrderNumber;

  const timeline: { label: string; value: string | null; done: boolean }[] = [
    {
      label: 'Original invoice',
      value: preCutover ? 'STORIS (before cutover)' : fmtDate(ret?.orderDate),
      done: true,
    },
    { label: 'Exchange entered', value: fmtDate(x.createdAt), done: true },
    { label: 'Return authorized', value: fmtDate(ret?.authorizedAt), done: !!ret },
    x.fulfillment === 'pickup'
      ? {
          label: goodsBack ? 'Picked up' : 'Pickup scheduled',
          value: goodsBack ? fmtDate(goodsBack) : (pickupLine ?? 'not scheduled'),
          done: !!goodsBack,
        }
      : {
          label: 'Goods dropped off',
          value: goodsBack ? fmtDate(goodsBack) : 'pending',
          done: !!goodsBack,
        },
    {
      label: o ? deliveryLabel(o.fulfillmentType) : 'Replacement',
      value: replacementWhen ? fmtDay(replacementWhen) : 'not scheduled',
      done: o?.status === 'completed',
    },
    { label: 'Exchange completed', value: fmtDate(x.completedAt), done: !!x.completedAt },
  ];

  return (
    <div
      className="inv"
      data-testid="exchange-ticket"
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
      <style>{DOC_THEME.css}</style>

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
          {sale?.business.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={sale.business.logoUrl}
              alt={businessName}
              style={{ maxHeight: 56, maxWidth: 220, display: 'block', marginBottom: 6 }}
            />
          ) : (
            <div style={{ fontSize: 22, fontWeight: 700, color: accent, marginBottom: 4 }}>
              {businessName}
            </div>
          )}
          <div style={{ fontSize: 11, color: '#374151' }} data-testid="exchange-store">
            {storeName && <div style={{ fontWeight: 700, color: '#111' }}>{storeName}</div>}
            <StoreAddress addressJson={sale?.location?.addressJson} />
          </div>
        </div>
        <div style={{ textAlign: 'right', flex: 'none' }}>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em', color: accent }}>
            Exchange Ticket
          </div>
          <div style={{ fontSize: 13, marginTop: 2 }} className="inv-num">
            <span style={{ color: MUTED }}>№</span>{' '}
            <strong data-testid="exchange-number">{x.number}</strong>
          </div>
          <div style={{ fontSize: 10.5, marginTop: 2 }}>
            <span style={{ color: MUTED }}>Status</span>{' '}
            <strong data-testid="exchange-status">{humanize(x.status, STATUS)}</strong>
            {x.evenExchange && (
              <span
                data-testid="exchange-even"
                style={{
                  marginLeft: 6,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: tint(accent, 0.85),
                  fontSize: 9.5,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                Even exchange
              </span>
            )}
          </div>
          <div style={{ fontSize: 10.5, color: MUTED, marginTop: 6 }} className="inv-num">
            <div>
              Exchange date <span style={{ color: '#111' }}>{fmtDate(x.createdAt)}</span>
            </div>
            <div>
              Original invoice <span style={{ color: '#111' }}>{originalNumber ?? '—'}</span>
              {preCutover && <span> · STORIS, not on file</span>}
              {ret?.orderDate && (
                <span>
                  {' '}
                  · <span style={{ color: '#111' }}>{fmtDate(ret.orderDate)}</span>
                </span>
              )}
            </div>
          </div>
          <div
            data-testid="exchange-callout"
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

      {sale?.business.invoiceHeaderNote && (
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
          {sale.business.invoiceHeaderNote}
        </div>
      )}

      {/* Customer · return leg · replacement leg */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 12,
          marginTop: 16,
        }}
      >
        <div className="inv-card" style={cardStyle} data-testid="exchange-customer">
          <div style={cardLabel}>Customer</div>
          <div style={{ fontWeight: 700 }}>
            {sale?.customer?.name ?? x.customerName ?? ret?.customerName ?? '—'}
          </div>
          <CustomerAddress sale={sale} ret={ret} />
        </div>

        <div
          className="inv-card"
          style={{ ...cardStyle, borderTop: `3px solid ${accent}` }}
          data-testid="exchange-return-leg"
        >
          <div style={cardLabel}>Return</div>
          <div className="inv-num" style={{ fontWeight: 700 }}>
            {x.rmaNumber ?? ret?.rmaNumber ?? '—'}
          </div>
          <DetailRow label="Status">
            {humanize(x.returnStatus ?? ret?.status, RETURN_STATUS)}
          </DetailRow>
          <DetailRow label="Taken by">{returnTakenBy ?? '—'}</DetailRow>
          <DetailRow label="Goods back">
            {x.fulfillment === 'pickup' ? 'Our truck picks up' : 'Customer drops off'}
          </DetailRow>
          {x.fulfillment === 'pickup' && pickupLine && !goodsBack && (
            <DetailRow label="Pickup">{pickupLine}</DetailRow>
          )}
          {goodsBack && <DetailRow label="Received">{fmtDate(goodsBack)}</DetailRow>}
          {ret?.reason && <DetailRow label="Reason">{ret.reason}</DetailRow>}
        </div>

        <div
          className="inv-card"
          style={{ ...cardStyle, borderTop: `3px solid ${accent}`, background: tint(accent, 0.94) }}
          data-testid="exchange-sale-leg"
        >
          <div style={cardLabel}>Replacement</div>
          <div className="inv-num" style={{ fontWeight: 700 }}>
            {x.saleOrderNumber ?? '—'}
          </div>
          <DetailRow label="Status">
            {humanize(x.saleOrderStatus ?? o?.status, ORDER_STATUS)}
          </DetailRow>
          <DetailRow label="Salesperson">
            {sale?.salespersonName ?? '—'}
            {sale?.secondSalespersonName ? ` / ${sale.secondSalespersonName}` : ''}
          </DetailRow>
          {o && (
            <DetailRow label="Fulfillment">
              <span style={{ textTransform: 'capitalize' }}>
                {o.fulfillmentType.replace(/_/g, ' ')}
              </span>
            </DetailRow>
          )}
          <DetailRow label={o ? deliveryLabel(o.fulfillmentType) : 'Scheduled'}>
            <strong className="inv-num">{fmtDay(replacementWhen) ?? 'Not scheduled'}</strong>
          </DetailRow>
          {o && (o.addressLine1 || o.addressCity) && (
            <div style={{ marginTop: 4, fontSize: 10.5, color: '#374151' }}>
              {o.addressLine1 && <div>{o.addressLine1}</div>}
              {o.addressLine2 && <div>{o.addressLine2}</div>}
              <div>
                {[o.addressCity, o.addressRegion, o.addressPostalCode].filter(Boolean).join(', ')}
              </div>
            </div>
          )}
          {o?.deliveryInstructions && (
            <div style={{ marginTop: 4, fontStyle: 'italic', color: '#374151', fontSize: 10.5 }}>
              {o.deliveryInstructions}
            </div>
          )}
        </div>
      </section>

      {/* Dates, in the order they happen */}
      <section
        className="inv-card"
        style={{ ...cardStyle, marginTop: 12, display: 'flex', gap: 0, padding: 0 }}
        data-testid="exchange-timeline"
      >
        {timeline.map((t, i) => (
          <div
            key={t.label}
            style={{
              flex: 1,
              minWidth: 0,
              padding: '8px 10px',
              borderLeft: i === 0 ? undefined : `1px solid ${RULE}`,
              background: t.done ? tint(accent, 0.94) : undefined,
            }}
          >
            <div style={{ ...cardLabel, marginBottom: 2 }}>{t.label}</div>
            <div
              className="inv-num"
              style={{
                fontSize: 11,
                fontWeight: t.done ? 700 : 400,
                color: t.done ? '#111' : MUTED,
              }}
            >
              {t.value ?? '—'}
            </div>
          </div>
        ))}
      </section>

      {/* Returned goods */}
      <div style={{ ...cardLabel, marginTop: 18, color: accent, fontSize: 10.5 }}>
        Returned by the customer
      </div>
      <table className="inv-lines" style={{ marginTop: 4 }} data-testid="exchange-return-lines">
        <thead>
          <tr style={{ borderBottom: `2px solid ${accent}` }}>
            <th style={{ ...th, color: accent, width: 28 }}>#</th>
            <th style={{ ...th, color: accent }}>Item</th>
            <th style={{ ...th, color: accent, width: 180 }}>Reason</th>
            <th style={{ ...th, color: accent, width: 44, textAlign: 'right' }}>Qty</th>
            <th style={{ ...th, color: accent, width: 84, textAlign: 'right' }}>Unit credit</th>
            <th style={{ ...th, color: accent, width: 92, textAlign: 'right' }}>Credit</th>
          </tr>
        </thead>
        <tbody>
          {(ret?.lines ?? []).map((l, i) => (
            <tr key={l.id}>
              <td style={{ ...td, color: MUTED }} className="inv-num">
                {i + 1}
              </td>
              <td style={{ ...td, fontWeight: 600 }}>{l.description ?? '—'}</td>
              <td style={{ ...td, color: '#374151' }}>
                {[l.reasonCode, l.reason].filter(Boolean).join(' — ') || '—'}
              </td>
              <td style={{ ...td, textAlign: 'right' }} className="inv-num">
                {l.quantity}
              </td>
              <td style={{ ...td, textAlign: 'right' }} className="inv-num">
                {usd(l.perUnitCents)}
              </td>
              <td style={{ ...td, textAlign: 'right', fontWeight: 600 }} className="inv-num">
                {usd(l.quantity * l.perUnitCents)}
              </td>
            </tr>
          ))}
          {!ret && (
            <tr>
              <td style={{ ...td, color: MUTED }} colSpan={6}>
                Return lines unavailable.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Replacement goods */}
      <div style={{ ...cardLabel, marginTop: 18, color: accent, fontSize: 10.5 }}>
        Replacement merchandise
      </div>
      <table className="inv-lines" style={{ marginTop: 4 }} data-testid="exchange-sale-lines">
        <thead>
          <tr style={{ borderBottom: `2px solid ${accent}` }}>
            <th style={{ ...th, color: accent, width: 28 }}>#</th>
            <th style={{ ...th, color: accent }}>Item</th>
            <th style={{ ...th, color: accent, width: 44, textAlign: 'right' }}>Qty</th>
            <th style={{ ...th, color: accent, width: 84, textAlign: 'right' }}>Price</th>
            <th style={{ ...th, color: accent, width: 84, textAlign: 'right' }}>Discount</th>
            <th style={{ ...th, color: accent, width: 92, textAlign: 'right' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {(sale?.lines ?? []).map((l, i) => {
            const meta = [l.model, l.brand].filter(Boolean).join(' · ');
            return (
              <tr key={l.id}>
                <td style={{ ...td, color: MUTED }} className="inv-num">
                  {i + 1}
                </td>
                <td style={td}>
                  <div style={{ fontWeight: 600 }}>{l.description}</div>
                  {meta && <div style={{ fontSize: 9.5, color: MUTED, marginTop: 1 }}>{meta}</div>}
                  {l.comment && (
                    <div style={{ fontSize: 9.5, fontStyle: 'italic', marginTop: 1 }}>
                      {l.comment}
                    </div>
                  )}
                </td>
                <td style={{ ...td, textAlign: 'right' }} className="inv-num">
                  {l.quantity}
                </td>
                <td style={{ ...td, textAlign: 'right' }} className="inv-num">
                  {usd(l.unitPriceCents)}
                </td>
                <td style={{ ...td, textAlign: 'right', color: MUTED }} className="inv-num">
                  {l.discountCents > 0 ? `-${usd(l.discountCents)}` : '—'}
                </td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 600 }} className="inv-num">
                  {usd(l.totalCents)}
                </td>
              </tr>
            );
          })}
          {!sale && (
            <tr>
              <td style={{ ...td, color: MUTED }} colSpan={6}>
                Replacement lines unavailable.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Payments + notes on the left, the settlement on the right */}
      <section style={{ display: 'flex', gap: 24, marginTop: 18, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 12 }}>
          {payments.length > 0 && (
            <div className="inv-card" style={cardStyle} data-testid="exchange-payments">
              <div style={cardLabel}>Paid on the replacement</div>
              <table>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td style={{ padding: '3px 0', fontSize: 11 }}>
                        {paymentLabel(p)}
                        {p.processorRef && (
                          <span style={{ color: MUTED, marginLeft: 6 }} className="inv-num">
                            {paymentRef(p.processorRef)}
                          </span>
                        )}
                      </td>
                      <td
                        style={{ padding: '3px 8px', fontSize: 11, color: MUTED }}
                        className="inv-num"
                      >
                        {fmtDate(p.createdAt)}
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
          <div className="inv-card" style={cardStyle} data-testid="exchange-terms">
            <div style={cardLabel}>How this exchange settles</div>
            <div style={{ fontSize: 10.5, color: '#374151' }}>
              The return credit is netted against the replacement now — the customer pays the net
              exchange. The credit is confirmed once the returned goods are back
              {x.fulfillment === 'pickup' ? ' on our truck' : ' at the store'}.
              {s.restockingFeeCents > 0 &&
                ` A restocking fee of ${usd(s.restockingFeeCents)} is withheld from the credit.`}
              {ret && ret.pickupFeeCents > 0 && ` Pickup fee: ${usd(ret.pickupFeeCents)}.`} Any
              credit left over is returned as {humanize(x.refundTender, TENDER)}.
            </div>
          </div>
          {x.notes && (
            <div className="inv-card" style={cardStyle} data-testid="exchange-notes">
              <div style={cardLabel}>Notes</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{x.notes}</div>
            </div>
          )}
        </div>

        <div
          className="inv-card"
          style={{ width: 300, flex: 'none' }}
          data-testid="exchange-totals"
        >
          <table>
            <tbody>
              {o && (
                <>
                  <TotalRow label="Replacement merchandise" value={usd(o.subtotalCents)} />
                  {o.discountCents + o.orderDiscountCents > 0 && (
                    <TotalRow
                      label="Discounts"
                      value={`-${usd(o.discountCents + o.orderDiscountCents)}`}
                    />
                  )}
                  {o.deliveryFeeCents > 0 && (
                    <TotalRow label="Delivery" value={usd(o.deliveryFeeCents)} />
                  )}
                  {o.installFeeCents > 0 && (
                    <TotalRow label="Installation" value={usd(o.installFeeCents)} />
                  )}
                  {o.otherFeeCents > 0 && (
                    <TotalRow label={o.otherFeeLabel ?? 'Other'} value={usd(o.otherFeeCents)} />
                  )}
                  <TotalRow
                    label={o.taxExemptReason ? `Tax (none — ${o.taxExemptReason})` : 'Tax'}
                    value={usd(o.taxCents)}
                  />
                </>
              )}
              <TotalRow label="Replacement total" value={usd(s.saleTotalCents)} bold rule />
              <TotalRow label="Return credit" value={`-${usd(s.returnCents)}`} />
              {s.restockingFeeCents > 0 && (
                <TotalRow label="Restocking fee withheld" value={usd(s.restockingFeeCents)} />
              )}
              <TotalRow
                label="Net exchange"
                value={`${s.saleTotalCents - s.creditCents < 0 ? '-' : ''}${usd(
                  Math.abs(s.saleTotalCents - s.creditCents),
                )}`}
                bold
                rule
              />
              {tenderPaidCents > 0 && (
                <TotalRow label="Paid on replacement" value={`-${usd(tenderPaidCents)}`} />
              )}
              <TotalRow
                label={callout.label}
                value={callout.value ?? usd(0)}
                bold
                highlight={{ background: accent, color: accentText }}
              />
            </tbody>
          </table>
        </div>
      </section>

      {/* Acknowledgement + signatures */}
      <section style={{ marginTop: 22 }} data-testid="exchange-signatures">
        <div style={{ fontSize: 10, color: '#374151' }}>
          I confirm the returned item(s) listed above are being exchanged for the replacement
          merchandise listed, and that the balance shown is correct.
        </div>
        <div style={{ display: 'flex', gap: 32, marginTop: 34 }}>
          {['Customer signature', 'Date', 'Associate', 'Date'].map((l, i) => (
            <div
              key={i}
              style={{
                flex: i % 2 === 0 ? 2 : 1,
                borderTop: '1px solid #111',
                paddingTop: 4,
                fontSize: 9.5,
                color: MUTED,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              {l}
            </div>
          ))}
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
        {sale?.business.invoiceFooterNote && (
          <div style={{ whiteSpace: 'pre-wrap' }}>{sale.business.invoiceFooterNote}</div>
        )}
        <div style={{ marginTop: sale?.business.invoiceFooterNote ? 6 : 0, color: MUTED }}>
          Exchange Ticket {x.number} · Printed {printedAt.toLocaleString()}
          {x.ticketPrintCount > 0 ? ` · copy ${x.ticketPrintCount + 1}` : ''}
        </div>
      </footer>
    </div>
  );
}

function deliveryLabel(fulfillmentType: string): string {
  if (fulfillmentType === 'pickup' || fulfillmentType === 'take_with') return 'Take with';
  if (fulfillmentType === 'will_call') return 'Will call';
  return 'Delivery';
}

function CustomerAddress({
  sale,
  ret,
}: {
  sale: OrderDocumentPayload | null;
  ret: ExchangeTicketReturn | null;
}) {
  const a = sale?.customer?.address;
  const line1 = a?.line1 ?? ret?.addressLine1;
  const line2 = a?.line2 ?? ret?.addressLine2;
  const city = [
    a?.city ?? ret?.addressCity,
    a?.region ?? ret?.addressRegion,
    a?.postalCode ?? ret?.addressPostalCode,
  ]
    .filter(Boolean)
    .join(', ');
  const phone = sale?.customer?.phone ?? ret?.customerPhone;
  const email = sale?.customer?.email ?? ret?.customerEmail;
  return (
    <>
      {line1 && <div>{line1}</div>}
      {line2 && <div>{line2}</div>}
      {city && <div>{city}</div>}
      {phone && <div>Ph. {formatPhone(phone)}</div>}
      {email && <div style={{ color: '#374151' }}>{email}</div>}
    </>
  );
}
