'use client';

import { useState } from 'react';
import { Money } from '@/components/money';
import { useOptionalActingStore } from '@/lib/acting-store';
import {
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  LoadingRows,
  ResetColumns,
  Stack,
  TableEmpty,
  TableWrap,
  Toolbar,
  useListColumns,
} from '@/components/ui';
import { LocationPicker, SectionError, StripTiles, useSection } from './kit';
import type { SalesHistoryPeriod, Strip } from './types';

/** STORIS Sales History tab (A21 D5): fourteen monthly periods. */
export function SalesHistoryPanel({ productId }: { productId: string }) {
  const [locationId, setLocationId] = useState('');
  const { data, error, loading } = useSection<{ strip: Strip; periods: SalesHistoryPeriod[] }>(
    `/v1/products/${productId}/activity/sales-history${locationId ? `?locationId=${locationId}` : ''}`,
  );
  // Cost access comes from /members/me; the rows alone cannot tell "no
  // access" from "no cost on file".
  const canSeeCost = useOptionalActingStore()?.me?.canSeeCost;
  const costHidden = canSeeCost === false;
  // The cost cell reads the access flag, so the columns live in the component.
  const SALES_COLUMNS: ColumnDef<SalesHistoryPeriod>[] = [
    { id: 'period', label: 'Period', sortValue: (p) => p.period, render: (p) => p.label },
    {
      id: 'sales',
      label: 'Sales amount',
      num: true,
      sortValue: (p) => p.salesCents,
      render: (p) => <Money cents={p.salesCents} />,
    },
    {
      id: 'cost',
      label: 'Cost amount',
      num: true,
      sortValue: (p) => p.costCents,
      render: (p) =>
        p.costCents === null ? (
          <em className="muted">{costHidden ? 'hidden' : '—'}</em>
        ) : (
          <Money cents={p.costCents} />
        ),
    },
    {
      id: 'profit',
      label: 'Profit %',
      num: true,
      sortValue: (p) => p.profitPercent,
      render: (p) => (p.profitPercent === null ? '—' : `${p.profitPercent.toFixed(2)}%`),
    },
    {
      id: 'shipped',
      label: 'Shipped quantity',
      num: true,
      sortValue: (p) => p.shipped,
      render: (p) => p.shipped,
    },
    {
      id: 'returned',
      label: 'Returned quantity',
      num: true,
      sortValue: (p) => p.returned,
      render: (p) => p.returned,
    },
    { id: 'net', label: 'Net number', num: true, sortValue: (p) => p.net, render: (p) => p.net },
  ];
  const cols = useListColumns(
    'products-activity-sales-history',
    SALES_COLUMNS,
    data?.periods ?? null,
  );
  return (
    <Stack>
      <Toolbar>
        <LocationPicker
          value={locationId}
          onChange={setLocationId}
          testId="sales-history-location"
        />
      </Toolbar>
      <StripTiles strip={data?.strip} />
      <SectionError error={error} />
      <Card
        title="Sales history"
        flush
        description={
          costHidden
            ? 'Register sales and completed orders by month. Cost and profit need product cost access.'
            : 'Register sales and completed orders by month; cost at catalog cost, profit on the pre-tax amount.'
        }
        data-testid="activity-sales-history"
      >
        {loading && !data ? (
          <LoadingRows rows={4} />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <ColumnHeadRow list={cols} testIdPrefix="products-activity-sales-history" />
              </thead>
              <tbody>
                {data && data.periods.length === 0 && (
                  <TableEmpty colSpan={cols.ordered.length}>No sales history.</TableEmpty>
                )}
                {cols.sorted.map((p) => (
                  <tr key={p.period} data-testid="activity-sales-period">
                    <ColumnCells list={cols} row={p} />
                  </tr>
                ))}
              </tbody>
            </table>
            <ResetColumns list={cols} />
          </TableWrap>
        )}
      </Card>
    </Stack>
  );
}
