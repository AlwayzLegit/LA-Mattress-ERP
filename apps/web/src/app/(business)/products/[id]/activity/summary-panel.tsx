'use client';

import { useState } from 'react';
import { Card, FormGrid, KeyValue, LoadingRows, Stack, Toolbar } from '@/components/ui';
import { LocationPicker, SectionError, useSection } from './kit';
import type { Summary } from './types';

/** STORIS Summary tab (A21 D12): beginning balances and month-to-date buckets. */
export function SummaryPanel({ productId }: { productId: string }) {
  const [locationId, setLocationId] = useState('');
  const { data, error, loading } = useSection<Summary>(
    `/v1/products/${productId}/activity/summary${locationId ? `?locationId=${locationId}` : ''}`,
  );
  const monthLabel = data
    ? new Date(data.monthStart).toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : '';
  return (
    <Stack>
      <Toolbar>
        <LocationPicker value={locationId} onChange={setLocationId} testId="summary-location" />
      </Toolbar>
      <SectionError error={error} />
      {loading && !data ? (
        <Card>
          <LoadingRows rows={4} />
        </Card>
      ) : data ? (
        <FormGrid cols={3}>
          <Card title="Inventory quantities" data-testid="activity-summary-quantities">
            <KeyValue
              rows={[
                { label: 'Beginning month balance', value: data.beginningBalance },
                { label: 'Beginning month As-Is balance', value: data.beginningAsIsBalance },
                { label: 'On hand', value: data.strip.onHand },
                { label: 'As-Is', value: data.strip.asIsOnHand },
                { label: 'Net PO', value: data.strip.netOnPo },
              ]}
            />
          </Card>
          <Card
            title={`Month to date regular — ${monthLabel}`}
            data-testid="activity-summary-regular"
          >
            <KeyValue
              rows={[
                { label: 'Received', value: data.regular.received },
                { label: 'Adjustments', value: data.regular.adjustments },
                { label: 'Transferred in', value: data.regular.transferredIn },
                { label: 'Transferred out', value: data.regular.transferredOut },
                { label: 'Sales', value: data.regular.sales },
              ]}
            />
          </Card>
          <Card title={`Month to date As-Is — ${monthLabel}`} data-testid="activity-summary-as-is">
            <KeyValue
              rows={[
                { label: 'Transferred in', value: data.asIs.transferredIn },
                { label: 'Transferred out', value: data.asIs.transferredOut },
                { label: 'Added', value: data.asIs.added },
                { label: 'Removed', value: data.asIs.removed },
              ]}
            />
            <p className="muted mt-2 text-xs">
              As-is pieces sell through their restocked SKU, so their sales sit in the regular Sales
              line.
            </p>
          </Card>
        </FormGrid>
      ) : null}
    </Stack>
  );
}
