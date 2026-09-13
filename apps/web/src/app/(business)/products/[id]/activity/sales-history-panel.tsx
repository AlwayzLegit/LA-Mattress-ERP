'use client';

import { useState } from 'react';
import { Money } from '@/components/money';
import { useOptionalActingStore } from '@/lib/acting-store';
import { Card, LoadingRows, Stack, TableEmpty, TableWrap, Toolbar } from '@/components/ui';
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
                <tr>
                  <th>Period</th>
                  <th className="num">Sales amount</th>
                  <th className="num">Cost amount</th>
                  <th className="num">Profit %</th>
                  <th className="num">Shipped quantity</th>
                  <th className="num">Returned quantity</th>
                  <th className="num">Net number</th>
                </tr>
              </thead>
              <tbody>
                {data && data.periods.length === 0 && (
                  <TableEmpty colSpan={7}>No sales history.</TableEmpty>
                )}
                {data?.periods.map((p) => (
                  <tr key={p.period} data-testid="activity-sales-period">
                    <td>{p.label}</td>
                    <td className="num">
                      <Money cents={p.salesCents} />
                    </td>
                    <td className="num">
                      {p.costCents === null ? (
                        <em className="muted">{costHidden ? 'hidden' : '—'}</em>
                      ) : (
                        <Money cents={p.costCents} />
                      )}
                    </td>
                    <td className="num">
                      {p.profitPercent === null ? '—' : `${p.profitPercent.toFixed(2)}%`}
                    </td>
                    <td className="num">{p.shipped}</td>
                    <td className="num">{p.returned}</td>
                    <td className="num">{p.net}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </Stack>
  );
}
