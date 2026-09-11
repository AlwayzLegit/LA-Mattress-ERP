'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Money } from '@/components/money';
import { Card, LoadingRows, Stack, TableEmpty, TableWrap, Toolbar } from '@/components/ui';
import { fmtDate, LocationPicker, SectionError, StripTiles, titleCase, useSection } from './kit';
import type { AsIsRow, Strip } from './types';

/** STORIS As-Is tab (A21 D11): pieces in review at a location. */
export function AsIsPanel({ productId }: { productId: string }) {
  const [locationId, setLocationId] = useState('');
  const { data, error, loading } = useSection<{ strip: Strip; rows: AsIsRow[] }>(
    `/v1/products/${productId}/activity/as-is${locationId ? `?locationId=${locationId}` : ''}`,
  );
  return (
    <Stack>
      <Toolbar>
        <LocationPicker value={locationId} onChange={setLocationId} testId="as-is-location" />
      </Toolbar>
      <StripTiles strip={data?.strip} />
      <SectionError error={error} />
      <Card
        title="As-Is pieces"
        flush
        description={
          <>
            Pieces of this product in as-is review. Price, sell or dispose of them on the{' '}
            <Link href="/as-is">As-Is queue</Link>.
          </>
        }
        data-testid="activity-as-is"
      >
        {loading && !data ? (
          <LoadingRows rows={3} />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Piece</th>
                  <th>SKU</th>
                  <th>Location</th>
                  <th>Received date</th>
                  <th>Status</th>
                  <th>Reason code</th>
                  <th className="num">Selling price</th>
                  <th>Sellable</th>
                  <th>Storage location</th>
                  <th>Source</th>
                  <th>Piece comments</th>
                </tr>
              </thead>
              <tbody>
                {data && data.rows.length === 0 && (
                  <TableEmpty colSpan={11}>No as-is pieces in review for this product.</TableEmpty>
                )}
                {data?.rows.map((r) => (
                  <tr key={r.id} data-testid="activity-as-is-row">
                    <td>
                      <code>{r.pieceNumber ?? '—'}</code>
                      {r.quantity > 1 && <span className="muted"> ×{r.quantity}</span>}
                    </td>
                    <td>
                      <code>{r.sku ?? '—'}</code>
                    </td>
                    <td>{r.locationName ?? '—'}</td>
                    <td>{fmtDate(r.receivedAt)}</td>
                    <td>
                      As-Is
                      {r.condition && <span className="muted"> · {titleCase(r.condition)}</span>}
                    </td>
                    <td>
                      {r.reasonCode ? (
                        <span title={r.reasonCode.description}>{r.reasonCode.code}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num">
                      {r.asIsPriceCents != null ? <Money cents={r.asIsPriceCents} /> : '—'}
                    </td>
                    <td>{r.sellable ? 'Yes' : 'No'}</td>
                    <td>{r.storageLocation ?? '—'}</td>
                    <td>{titleCase(r.source)}</td>
                    <td className="muted">{r.notes ?? '—'}</td>
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
