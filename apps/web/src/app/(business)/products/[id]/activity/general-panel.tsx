'use client';

import { centsToInputString, PRODUCT_PURCHASE_STATUS_LABELS } from '@jetnine/shared';
import type { ProductPurchaseStatus } from '@jetnine/shared';
import { Money } from '@/components/money';
import { Card, Field, FormGrid, Input, KeyValue, StatusBadge } from '@/components/ui';
import { SectionError, useSection } from './kit';
import type { General, Shipping } from './types';

/**
 * STORIS General Information (A21 D9): the Group / Category / Collection
 * block, Status, Price, Cost and Shipping information. The A19 cards
 * (Descriptive, Purchase status & packing, Tax class, Brand & collection,
 * Variants, Reorder automation, Images) render under this on the page.
 */
export function GeneralPanel({
  product,
  primary,
  patchProduct,
}: {
  product: {
    id: string;
    group: string | null;
    categoryName: string | null;
    collectionName: string | null;
    purchaseStatus: ProductPurchaseStatus | string;
    isActive: boolean;
    suggestedRetailCents: number | null;
    shipping: Shipping;
  };
  primary: { priceCents: number; costCents: number | null } | undefined;
  patchProduct: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const { data, error } = useSection<General>(`/v1/products/${product.id}/activity/general`);
  const cost = data?.cost;
  const hidden = <em className="muted">hidden</em>;
  const money = (cents: number | null | undefined) =>
    cents == null ? hidden : <Money cents={cents} />;

  const shippingField = (key: keyof Shipping, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        min={0}
        step="0.01"
        defaultValue={product.shipping[key] ?? ''}
        aria-label={label}
        data-testid={`shipping-${key}`}
        onBlur={(e) => {
          const raw = e.target.value.trim();
          const next = raw === '' ? null : Number(raw);
          if (next !== null && (!Number.isFinite(next) || next < 0)) return;
          if (next !== product.shipping[key]) void patchProduct({ shipping: { [key]: next } });
        }}
      />
    </Field>
  );

  return (
    <>
      <SectionError error={error} />
      <FormGrid cols={3}>
        <Card title="Group, category & collection" data-testid="general-grouping">
          <KeyValue
            rows={[
              { label: 'Group', value: product.group ?? '—' },
              { label: 'Category', value: product.categoryName ?? '—' },
              { label: 'Collection', value: product.collectionName ?? '—' },
              {
                label: 'Warranty category',
                value: <em className="muted">protection plans (A20 phase 2)</em>,
              },
            ]}
          />
        </Card>
        <Card title="Status information" data-testid="general-status">
          <KeyValue
            rows={[
              {
                label: 'Purchase',
                value:
                  PRODUCT_PURCHASE_STATUS_LABELS[product.purchaseStatus as ProductPurchaseStatus] ??
                  product.purchaseStatus,
              },
              {
                label: 'Distribution',
                value: <StatusBadge status={product.isActive ? 'active' : 'inactive'} />,
              },
            ]}
          />
        </Card>
        <Card title="Price information" data-testid="general-price">
          <KeyValue
            rows={[
              { label: 'Selling', value: primary ? <Money cents={primary.priceCents} /> : '—' },
              { label: 'Sale', value: <em className="muted">not modeled (A19 D12)</em> },
              { label: 'Markdown', value: <em className="muted">not modeled (A19 D12)</em> },
              { label: 'Sale end date', value: <em className="muted">not modeled (A19 D12)</em> },
              {
                label: 'Suggested retail',
                value: (
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    defaultValue={
                      product.suggestedRetailCents != null
                        ? centsToInputString(product.suggestedRetailCents)
                        : ''
                    }
                    aria-label="Suggested retail price"
                    data-testid="suggested-retail"
                    className="w-28"
                    onBlur={(e) => {
                      const raw = e.target.value.trim();
                      const next = raw === '' ? null : Math.round(Number(raw) * 100);
                      if (next !== null && (!Number.isInteger(next) || next < 0)) return;
                      if (next !== product.suggestedRetailCents)
                        void patchProduct({ suggestedRetailCents: next });
                    }}
                  />
                ),
              },
            ]}
          />
        </Card>
        <Card
          title="Cost information"
          description={
            cost?.vendorName
              ? `Landed cost lines from ${cost.vendorName}'s Advanced Vendor Settings.`
              : 'Average cost follows the FIFO layers; PO replacement is the catalog cost.'
          }
          data-testid="general-cost"
        >
          <KeyValue
            rows={[
              {
                label: 'Average',
                value: cost ? (
                  cost.averageCents != null ? (
                    <>
                      <Money cents={cost.averageCents} />
                      <span className="muted"> · {cost.layerUnits} units</span>
                    </>
                  ) : cost.poReplacementCents != null ? (
                    <em className="muted">no cost layers yet</em>
                  ) : (
                    hidden
                  )
                ) : (
                  '…'
                ),
              },
              { label: 'PO replacement', value: cost ? money(cost.poReplacementCents) : '…' },
              { label: 'Average landed', value: cost ? money(cost.averageLandedCents) : '…' },
              {
                label: 'Freight per unit',
                value: cost
                  ? cost.freightPerUnitCents != null
                    ? money(cost.freightPerUnitCents)
                    : '—'
                  : '…',
              },
              {
                label: 'Freight percent',
                value: cost ? (cost.freightPercent != null ? `${cost.freightPercent}%` : '—') : '…',
              },
            ]}
          />
        </Card>
        <Card
          title="Shipping information"
          description="Display and print only — delivery capacity keeps using the variant's capacity units."
          data-testid="general-shipping"
        >
          <FormGrid cols={2}>
            {shippingField(
              'deliveryVolume',
              'Delivery volume',
              data?.capacityUnits != null ? `Capacity units: ${data.capacityUnits}` : undefined,
            )}
            {shippingField('heightIn', 'Height (in)')}
            {shippingField('weightLb', 'Shipping weight (lb)')}
            {shippingField('widthIn', 'Width (in)')}
            {shippingField('shippingVolume', 'Shipping volume')}
            {shippingField('depthIn', 'Depth (in)')}
          </FormGrid>
        </Card>
      </FormGrid>
    </>
  );
}
