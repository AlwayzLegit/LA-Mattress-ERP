'use client';

import Link from 'next/link';
import { Fragment, useMemo, type ReactNode } from 'react';
import { Money } from '@/components/money';
import {
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  type ListColumns,
  ResetColumns,
  useListColumns,
} from '@/components/ui';
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
  usedColumns,
  type Doc,
  type Line,
  type LocationGroup,
  type Report,
  type Totals,
  type TypeGroup,
} from './ws-lib';

/** One body row = one document line, with the location / type / document it sits under. */
interface LineRow {
  loc: LocationGroup;
  t: TypeGroup;
  d: Doc;
  l: Line;
}

function docKey(d: Doc): string {
  return `${d.documentId}:${d.adjustmentKind ?? 'doc'}:${d.time}`;
}

/**
 * Lines: every item line, location → type → order → line, the STORIS
 * TE.320 body. Cleaned up for the screen (owner 2026-09-26 audit): the
 * Total column always fits (charges / misc fee only when used), entered-by
 * initials have their own "By" column instead of sitting under Total,
 * percents carry a %, and each order's heading is one short line.
 */
export function LinesView({ report, matches }: { report: Report; matches: (d: Doc) => boolean }) {
  const profit = report.canSeeProfit;
  const used = usedColumns(report);
  const multiDay = report.range.start !== report.range.end;

  const lineColumns = useMemo<ColumnDef<LineRow>[]>(() => {
    const cols: ColumnDef<LineRow>[] = [
      {
        id: 'qty',
        label: 'Qty',
        num: true,
        sortValue: (r) => r.l.quantity,
        render: (r) => r.l.quantity || '',
      },
      {
        id: 'productNumber',
        label: 'SKU',
        sortValue: (r) => r.l.productNumber,
        render: (r) => <span className="mono">{r.l.productNumber ?? '—'}</span>,
      },
      {
        id: 'description',
        label: 'Description',
        sortValue: (r) => r.l.description,
        render: (r) => cleanDescription(r.l.description),
      },
      {
        id: 'merch',
        label: 'Merch',
        num: true,
        sortValue: (r) => r.l.merchCents,
        render: (r) => <Money cents={r.l.merchCents} />,
      },
    ];
    if (profit) {
      cols.push(
        {
          id: 'cost',
          label: 'Cost',
          title: 'Total cost for the quantity on this row',
          num: true,
          sortValue: (r) => costCents(r.l),
          render: (r) => (costCents(r.l) == null ? '—' : <Money cents={costCents(r.l)!} />),
        },
        {
          id: 'profit',
          label: 'GP',
          title: 'Gross profit',
          num: true,
          sortValue: (r) => r.l.profitCents,
          render: (r) => (r.l.profitCents == null ? '—' : <Money cents={r.l.profitCents} />),
        },
        {
          id: 'profitPct',
          label: 'GP %',
          num: true,
          sortValue: (r) => r.l.profitPct,
          render: (r) => fmtPct(r.l.profitPct),
        },
      );
    }
    if (used.charges) cols.push({ id: 'charges', label: 'Charges', num: true, render: () => null });
    if (used.miscFee)
      cols.push({ id: 'miscFee', label: 'Misc fee', num: true, render: () => null });
    cols.push(
      { id: 'tax', label: 'Tax', num: true, render: () => null },
      { id: 'total', label: 'Total', num: true, render: () => null },
      {
        id: 'by',
        label: 'By',
        title: 'Entered by (initials)',
        sortValue: (r) => r.l.enteredBy,
        render: (r) => <span className="text-muted">{r.l.enteredBy ?? ''}</span>,
      },
    );
    return cols;
  }, [profit, used.charges, used.miscFee]);

  const lineRows = useMemo<LineRow[]>(
    () =>
      report.locations.flatMap((loc) =>
        loc.types.flatMap((t) =>
          t.documents.flatMap((d) => d.lines.map((l) => ({ loc, t, d, l }))),
        ),
      ),
    [report],
  );
  const cols = useListColumns('reports-written-sales', lineColumns, lineRows);
  // Sorted once across the report, then bucketed back under each document.
  const linesByDoc = useMemo(() => {
    const by = new Map<string, LineRow[]>();
    for (const r of cols.sorted) {
      const k = `${r.loc.locationId}|${r.t.key}|${docKey(r.d)}`;
      const bucket = by.get(k);
      if (bucket) bucket.push(r);
      else by.set(k, [r]);
    }
    return by;
  }, [cols.sorted]);

  return (
    <>
      {report.locations.map((loc) => (
        <Card key={loc.locationId} title={`Location · ${loc.locationName}`} flush>
          <div className={styles.tableWrap}>
            <table className={`table ${styles.compact}`} data-testid="ws-location">
              <thead>
                <ColumnHeadRow list={cols} testIdPrefix="reports-written-sales" />
              </thead>
              <tbody>
                {loc.types.map((t) => (
                  <Fragment key={t.key}>
                    <tr className={styles.typeHeading}>
                      <td colSpan={cols.ordered.length}>Type {t.label}</td>
                    </tr>
                    {t.documents.filter(matches).map((d) => (
                      <Fragment key={docKey(d)}>
                        <tr data-testid="ws-document" className={styles.docHeadRow}>
                          <td colSpan={cols.ordered.length}>
                            <DocHeading d={d} multiDay={multiDay} />
                          </td>
                        </tr>
                        {(linesByDoc.get(`${loc.locationId}|${t.key}|${docKey(d)}`) ?? []).map(
                          (r) => (
                            <tr key={r.l.lineId} data-testid="ws-line">
                              <ColumnCells list={cols} row={r} />
                            </tr>
                          ),
                        )}
                        <TotalsRow
                          list={cols}
                          label={`Total for ${d.number}`}
                          t={d.totals}
                          testid="ws-order-total"
                        />
                      </Fragment>
                    ))}
                    <TotalsRow
                      list={cols}
                      label={`Total for ${t.label}`}
                      t={t.totals}
                      testid="ws-type-total"
                    />
                  </Fragment>
                ))}
                <TotalsRow
                  list={cols}
                  label={`Total for ${loc.locationName}`}
                  t={loc.totals}
                  strong
                  testid="ws-location-total"
                />
                {report.locations.length > 1 &&
                  loc === report.locations[report.locations.length - 1] && (
                    <TotalsRow
                      list={cols}
                      label="Grand total, all stores"
                      t={report.totals}
                      strong
                      testid="ws-grand-total"
                    />
                  )}
              </tbody>
            </table>
            <ResetColumns list={cols} />
          </div>
        </Card>
      ))}
    </>
  );
}

/** One short line per order: number, when, who bought (and their phone), who sold. */
function DocHeading({ d, multiDay }: { d: Doc; multiDay: boolean }) {
  return (
    <>
      <div className={styles.documentMeta}>
        <Link href={docHref(d)} className="font-semibold">
          {d.number}
        </Link>
        {d.adjustmentKind && (
          <span className={styles.adjBadge}>
            {ADJUSTMENT_LABEL[d.adjustmentKind]}
            {d.adjustmentReason ? ` — ${d.adjustmentReason}` : ''}
          </span>
        )}
        <span className="text-muted">
          {multiDay ? `${fmtDate(d.date)} · ` : ''}
          {fmtTime(d.time)}
        </span>
        <span>
          {customerLabel(d)}
          {d.customerPhone ? <span className="text-muted"> · {d.customerPhone}</span> : null}
        </span>
        {d.customerCode && (
          <span className={styles.printOnly}>
            <span className="text-muted">Cust </span>
            {d.customerCode}
          </span>
        )}
        <span>
          <span className="text-muted">Sold by </span>
          {d.salespeople.join(', ') || '—'}
        </span>
        {d.marketingCode && (
          <span>
            <span className="text-muted">Mkt </span>
            {d.marketingCode}
          </span>
        )}
      </div>
      {d.address ? (
        <div className="text-xs text-muted" data-testid="ws-address-line">
          {d.address}
        </div>
      ) : null}
      {d.comments.length > 0 ? (
        <ul className="mt-1 text-xs text-muted" data-testid="ws-comments">
          {d.comments.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/**
 * A totals row's cells in the header's order: the label spans the leading
 * columns that carry no total, each total sits under its own column and
 * the rest stay blank, so a moved column keeps its total under it.
 */
function TotalCells<Row>({
  list,
  label,
  totals,
}: {
  list: ListColumns<Row>;
  label: ReactNode;
  totals: Record<string, ReactNode>;
}) {
  const firstTotal = list.ordered.findIndex((c) => c.id in totals);
  const lead = firstTotal < 0 ? list.ordered.length : firstTotal;
  let placed = lead > 0;
  return (
    <>
      {lead > 0 && (
        <td colSpan={lead} className="text-right">
          {label}
        </td>
      )}
      {list.ordered.slice(lead).map((c) => {
        if (c.id in totals) {
          return (
            <td key={c.id} className="num">
              {totals[c.id]}
            </td>
          );
        }
        if (!placed) {
          placed = true;
          return (
            <td key={c.id} className="text-right">
              {label}
            </td>
          );
        }
        return <td key={c.id} />;
      })}
    </>
  );
}

function TotalsRow({
  list,
  label,
  t,
  strong,
  testid,
}: {
  list: ListColumns<LineRow>;
  label: string;
  t: Totals;
  strong?: boolean;
  testid?: string;
}) {
  return (
    <tr data-testid={testid} className={strong ? styles.grandRow : styles.subtotalRow}>
      <TotalCells
        list={list}
        label={label}
        totals={{
          merch: <Money cents={t.merchCents} />,
          cost: costCents(t) == null ? '—' : <Money cents={costCents(t)!} />,
          profit: t.profitCents == null ? '—' : <Money cents={t.profitCents} />,
          profitPct: fmtPct(t.profitPct),
          charges: <Money cents={t.chargesCents} />,
          miscFee: <Money cents={t.miscFeeCents} />,
          tax: <Money cents={t.taxCents} />,
          total: <Money cents={t.totalCents} />,
        }}
      />
    </tr>
  );
}
