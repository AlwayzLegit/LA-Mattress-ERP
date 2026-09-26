'use client';

import { Money } from '@/components/money';
import { Card } from '@/components/ui';
import styles from './written-sales.module.css';
import { bySalesperson, costCents, fmtPct, usedColumns, type Report, type Totals } from './ws-lib';

/**
 * Summary: one compact table by store and type, then written sales by
 * salesperson (credited like commissions). Replaces the old summary, which
 * printed a heading, a type total and a location total for one line of
 * numbers.
 */
export function SummaryView({ report }: { report: Report }) {
  const profit = report.canSeeProfit;
  const used = usedColumns(report);
  const people = bySalesperson(report);
  const multiStore = report.locations.length > 1;

  const money = (t: Totals) => (
    <>
      <td className="num">
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
      <td className="num font-semibold">
        <Money cents={t.totalCents} />
      </td>
    </>
  );
  const head = (
    <>
      <th className="num">Merch</th>
      {profit && (
        <>
          <th className="num">Cost</th>
          <th className="num">Gross profit</th>
          <th className="num">GP %</th>
        </>
      )}
      {used.charges && <th className="num">Charges</th>}
      {used.miscFee && <th className="num">Misc fee</th>}
      <th className="num">Tax</th>
      <th className="num">Total</th>
    </>
  );

  return (
    <div className={styles.summaryGrid}>
      <Card title="By store" flush data-testid="ws-summary-stores">
        <div className={styles.tableWrap}>
          <table className={`table ${styles.compact}`}>
            <thead>
              <tr>
                <th>{multiStore ? 'Store / type' : 'Type'}</th>
                <th className="num">Docs</th>
                {head}
              </tr>
            </thead>
            <tbody>
              {report.locations.map((loc) => (
                <SummaryStore
                  key={loc.locationId}
                  multiStore={multiStore}
                  loc={loc}
                  cells={money}
                />
              ))}
              <tr className={styles.grandRow} data-testid="ws-summary-grand">
                <td>Total</td>
                <td className="num">{report.totals.documents}</td>
                {money(report.totals)}
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="By salesperson"
        description="A split sale is credited by its split, the way commissions are."
        flush
        data-testid="ws-summary-people"
      >
        <div className={styles.tableWrap}>
          <table className={`table ${styles.compact}`}>
            <thead>
              <tr>
                <th>Salesperson</th>
                <th className="num">Sales</th>
                <th className="num">Written</th>
                <th className="num">Avg sale</th>
                {profit && (
                  <>
                    <th className="num">Gross profit</th>
                    <th className="num">GP %</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {people.length === 0 && (
                <tr>
                  <td colSpan={profit ? 6 : 4} className="muted">
                    Nothing written.
                  </td>
                </tr>
              )}
              {people.map((p) => (
                <tr key={p.name} data-testid="ws-person-row">
                  <td>{p.name}</td>
                  <td className="num">{p.orders}</td>
                  <td className="num font-semibold">
                    <Money cents={p.totalCents} />
                  </td>
                  <td className="num">
                    {p.orders > 0 ? <Money cents={Math.round(p.totalCents / p.orders)} /> : '—'}
                  </td>
                  {profit && (
                    <>
                      <td className="num">
                        {p.profitCents == null ? '—' : <Money cents={p.profitCents} />}
                      </td>
                      <td className="num">{fmtPct(p.profitPct)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function SummaryStore({
  loc,
  multiStore,
  cells,
}: {
  loc: Report['locations'][number];
  multiStore: boolean;
  cells: (t: Totals) => React.ReactNode;
}) {
  return (
    <>
      {multiStore && (
        <tr className={styles.storeRow}>
          <td>{loc.locationName}</td>
          <td className="num">{loc.totals.documents}</td>
          {cells(loc.totals)}
        </tr>
      )}
      {loc.types.map((t) => (
        <tr key={t.key} data-testid="ws-summary-type">
          <td className={multiStore ? styles.indent : undefined}>{t.label}</td>
          <td className="num">{t.totals.documents}</td>
          {cells(t.totals)}
        </tr>
      ))}
    </>
  );
}
