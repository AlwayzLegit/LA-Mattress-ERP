'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Money } from '@/components/money';
import { Card, cx } from '@/components/ui';
import styles from './written-sales.module.css';
import {
  ADJUSTMENT_LABEL,
  cleanDescription,
  costCents,
  customerLabel,
  docHref,
  fmtDate,
  fmtPct,
  fmtTime,
  isAdjustment,
  itemCount,
  usedColumns,
  type Doc,
  type Report,
  type Totals,
} from './ws-lib';

/**
 * Orders (the default view): one row per order — who bought, who sold,
 * how much, how much it made — and a click opens its items. On a phone
 * every order is a card instead.
 */
export function OrdersView({
  report,
  matches,
}: {
  report: Report;
  /** Search filter; totals rows keep the whole report's figures. */
  matches: (d: Doc) => boolean;
}) {
  const profit = report.canSeeProfit;
  const used = usedColumns(report);
  const multiDay = report.range.start !== report.range.end;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const moneyCols = 3 + (profit ? 3 : 0) + (used.charges ? 1 : 0) + (used.miscFee ? 1 : 0);
  const colCount = 5 + moneyCols;

  const figures = (t: Totals, strong = false) => (
    <>
      <td className={cx('num', strong && 'font-semibold')}>
        <Money cents={t.merchCents} />
      </td>
      {profit && (
        <>
          <td className="num">{costCents(t) == null ? '—' : <Money cents={costCents(t)!} />}</td>
          <td className="num">{t.profitCents == null ? '—' : <Money cents={t.profitCents} />}</td>
          <td className="num">{fmtPct(t.profitPct)}</td>
        </>
      )}
      {used.charges && (
        <td className="num">
          <Money cents={t.chargesCents} />
        </td>
      )}
      {used.miscFee && (
        <td className="num">
          <Money cents={t.miscFeeCents} />
        </td>
      )}
      <td className="num">
        <Money cents={t.taxCents} />
      </td>
      <td className={cx('num', strong ? 'font-bold' : 'font-semibold')}>
        <Money cents={t.totalCents} />
      </td>
    </>
  );

  return (
    <>
      {report.locations.map((loc) => (
        <Card
          key={loc.locationId}
          title={loc.locationName}
          description={`${loc.totals.documents} ${loc.totals.documents === 1 ? 'document' : 'documents'}`}
          flush
          data-testid="ws-location"
        >
          {/* Desktop / print: the table. */}
          <div className={cx(styles.tableWrap, styles.wideOnly)}>
            <table className={`table ${styles.compact}`} data-testid="ws-orders-table">
              <thead>
                <tr>
                  <th className={styles.chevCol} aria-label="Open" />
                  <th>Order</th>
                  <th>{multiDay ? 'Written' : 'Time'}</th>
                  <th>Customer</th>
                  <th>Salesperson</th>
                  <th className="num">Items</th>
                  <th className="num">Merch</th>
                  {profit && (
                    <>
                      <th className="num">Cost</th>
                      <th className="num">GP</th>
                      <th className="num">GP %</th>
                    </>
                  )}
                  {used.charges && <th className="num">Charges</th>}
                  {used.miscFee && <th className="num">Misc fee</th>}
                  <th className="num">Tax</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {loc.types.map((t) => {
                  const shown = t.documents.filter(matches);
                  return (
                    <Fragment key={t.key}>
                      <tr className={styles.typeHeading}>
                        <td colSpan={colCount + 1}>
                          {t.label}
                          <span className={styles.typeCount}>{t.documents.length}</span>
                        </td>
                      </tr>
                      {shown.map((d) => {
                        const k = `${loc.locationId}|${t.key}|${d.documentId}|${d.adjustmentKind ?? ''}|${d.time}`;
                        const isOpen = open.has(k);
                        return (
                          <Fragment key={k}>
                            <tr
                              className={cx(styles.orderRow, isOpen && styles.isOpen)}
                              onClick={(e) => {
                                if ((e.target as HTMLElement).closest('a')) return;
                                toggle(k);
                              }}
                              data-testid="ws-order-row"
                            >
                              <td className={styles.chevCol}>
                                <button
                                  type="button"
                                  className={styles.chev}
                                  aria-expanded={isOpen}
                                  aria-label={`${isOpen ? 'Hide' : 'Show'} items on ${d.number}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggle(k);
                                  }}
                                >
                                  <ChevronRight size={14} aria-hidden />
                                </button>
                              </td>
                              <td className="nowrap">
                                <Link href={docHref(d)} className="font-semibold">
                                  {d.number}
                                </Link>
                                {d.adjustmentKind && (
                                  <span className={styles.adjBadge}>
                                    {ADJUSTMENT_LABEL[d.adjustmentKind]}
                                  </span>
                                )}
                              </td>
                              <td className="nowrap">
                                {multiDay ? `${fmtDate(d.date)} ` : ''}
                                {fmtTime(d.time)}
                              </td>
                              <td>
                                <Customer d={d} />
                              </td>
                              <td>{d.salespeople.join(', ') || '—'}</td>
                              <td className="num">{isAdjustment(d) ? '' : itemCount(d)}</td>
                              {figures(d.totals)}
                            </tr>
                            {isOpen && (
                              <tr className={styles.detailRow} data-testid="ws-order-detail">
                                <td className={styles.chevCol} />
                                <td colSpan={colCount}>
                                  <OrderDetail d={d} profit={profit} />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                      {loc.types.length > 1 && (
                        <tr className={styles.subtotalRow}>
                          <td className={styles.chevCol} />
                          <td colSpan={5}>{t.label} total</td>
                          {figures(t.totals)}
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                <tr className={styles.grandRow} data-testid="ws-location-total">
                  <td className={styles.chevCol} />
                  <td colSpan={5}>{loc.locationName} total</td>
                  {figures(loc.totals, true)}
                </tr>
              </tbody>
            </table>
          </div>

          {/* Phone: a card per order. */}
          <ul className={styles.narrowOnly} data-testid="ws-order-cards">
            {loc.types.flatMap((t) =>
              t.documents.filter(matches).map((d) => {
                const k = `${loc.locationId}|${t.key}|${d.documentId}|${d.adjustmentKind ?? ''}|${d.time}`;
                const isOpen = open.has(k);
                return (
                  <li key={k} className={styles.orderCard}>
                    <button
                      type="button"
                      className={styles.orderCardHead}
                      aria-expanded={isOpen}
                      onClick={() => toggle(k)}
                    >
                      <span className={styles.orderCardTop}>
                        <strong>{d.number}</strong>
                        <strong>
                          <Money cents={d.totals.totalCents} />
                        </strong>
                      </span>
                      <span className={styles.orderCardMeta}>
                        {customerLabel(d)}
                        {d.customerPhone ? ` · ${d.customerPhone}` : ''}
                      </span>
                      <span className={styles.orderCardMeta}>
                        {fmtTime(d.time)} · {d.salespeople.join(', ') || 'No salesperson'}
                        {profit && d.totals.profitPct != null
                          ? ` · GP ${fmtPct(d.totals.profitPct)}`
                          : ''}
                        {d.adjustmentKind ? ` · ${ADJUSTMENT_LABEL[d.adjustmentKind]}` : ''}
                      </span>
                    </button>
                    {isOpen && (
                      <div className={styles.orderCardBody}>
                        <OrderDetail d={d} profit={profit} narrow />
                        <Link href={docHref(d)} className="text-sm">
                          Open {d.number}
                        </Link>
                      </div>
                    )}
                  </li>
                );
              }),
            )}
            <li className={styles.orderCardTotal}>
              <span>{loc.locationName} total</span>
              <strong>
                <Money cents={loc.totals.totalCents} />
              </strong>
            </li>
          </ul>
        </Card>
      ))}
    </>
  );
}

function Customer({ d }: { d: Doc }) {
  const name = customerLabel(d);
  return (
    <span className={styles.customer}>
      {d.customerId ? (
        <Link href={`/customers/${d.customerId}`} className={styles.customerName}>
          {name}
        </Link>
      ) : (
        <span className={styles.customerName}>{name}</span>
      )}
      {d.customerPhone && <span className={styles.customerPhone}>{d.customerPhone}</span>}
    </span>
  );
}

/** The opened order: its items, and the address / reason / notes when the report carries them. */
function OrderDetail({ d, profit, narrow }: { d: Doc; profit: boolean; narrow?: boolean }) {
  return (
    <div className={styles.detail}>
      {narrow && d.lines.length > 0 && (
        <ul className={styles.itemList}>
          {d.lines.map((l) => (
            <li key={l.lineId}>
              <span>
                {l.quantity ? `${l.quantity} × ` : ''}
                {cleanDescription(l.description)}
                <span className={styles.itemSku}>{l.productNumber ?? ''}</span>
              </span>
              <span className="num">
                <Money cents={l.merchCents} />
                {profit && l.profitPct != null ? (
                  <span className={styles.itemSku}>GP {fmtPct(l.profitPct)}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!narrow && d.lines.length > 0 && (
        <table className={styles.itemTable}>
          <thead>
            <tr>
              <th className="num">Qty</th>
              <th>SKU</th>
              <th>Item</th>
              <th className="num">Merch</th>
              {profit && (
                <>
                  <th className="num">Cost</th>
                  <th className="num">GP</th>
                  <th className="num">GP %</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l) => (
              <tr key={l.lineId}>
                <td className="num">{l.quantity || ''}</td>
                <td className="mono">{l.productNumber ?? '—'}</td>
                <td>{cleanDescription(l.description)}</td>
                <td className="num">
                  <Money cents={l.merchCents} />
                </td>
                {profit && (
                  <>
                    <td className="num">
                      {costCents(l) == null ? '—' : <Money cents={costCents(l)!} />}
                    </td>
                    <td className="num">
                      {l.profitCents == null ? '—' : <Money cents={l.profitCents} />}
                    </td>
                    <td className="num">{fmtPct(l.profitPct)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className={styles.detailFacts}>
        {d.adjustmentReason && <span>Reason: {d.adjustmentReason}</span>}
        {d.address && <span>Ship to: {d.address}</span>}
        {d.marketingCode && <span>Marketing: {d.marketingCode}</span>}
        {d.comments.map((c, i) => (
          <span key={i}>{c}</span>
        ))}
      </div>
    </div>
  );
}
