'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Alert, Button, Field, Input, KeyValue, TableWrap } from '@/components/ui';
import { ActionDialog, errorText, money } from './dialog';
import { LinePicker } from './line-picker';
import type {
  ActionLine,
  ActionOrder,
  CommissionTable,
  CostedLines,
  LineProduct,
  LineStock,
  LinkedDocuments,
  TaxInfo,
} from './types';

function useFetch<T>(path: string | null): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setData(null);
    setError(null);
    api<T>(path)
      .then((d) => live && setData(d))
      .catch((err) => {
        if (!live) return;
        setError(
          err instanceof ApiError && err.status === 403
            ? 'You do not have access to this view.'
            : errorText(err),
        );
      });
    return () => {
      live = false;
    };
  }, [path]);
  return { data, error };
}

function pct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/** STORIS "Order Tax Information". */
export function TaxInfoDialog({ order, onClose }: { order: ActionOrder; onClose: () => void }) {
  const { data, error } = useFetch<TaxInfo>(`/v1/orders/${order.id}/tax-info`);
  return (
    <ActionDialog title={`Order Tax Information — ${order.number}`} onClose={onClose} wide>
      {error && <Alert tone="error">{error}</Alert>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (
        <>
          <KeyValue
            rows={[
              { label: 'Store tax rate', value: pct(data.storeRateBps) },
              { label: 'Merchandise', value: money(data.subtotalCents) },
              { label: 'Order discount', value: money(-data.orderDiscountCents) },
              { label: 'All discounts', value: money(-data.discountCents) },
              { label: 'Tax', value: <strong>{money(data.taxCents)}</strong> },
              { label: 'Total', value: money(data.totalCents) },
              { label: 'Untaxed lines', value: String(data.untaxedLines) },
            ]}
          />
          <TableWrap>
            <table className="table" data-testid="tax-info-table">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Tax class</th>
                  <th className="num">Rate</th>
                  <th className="num">Taxable</th>
                  <th className="num">Tax</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      {l.description} × {l.quantity}
                    </td>
                    <td>{l.taxClassName ?? (l.taxRateBps === 0 ? 'Untaxed' : 'Store default')}</td>
                    <td className="num">{pct(l.taxRateBps)}</td>
                    <td className="num">{money(l.lineSubtotalCents)}</td>
                    <td className="num">{money(l.taxCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <p className="muted" style={{ marginTop: 8 }}>
            The order discount is spread across taxed lines pro rata before tax; fees are never
            taxed. Tax-exempt customers are not modeled yet.
          </p>
        </>
      )}
    </ActionDialog>
  );
}

/** STORIS "Costed Line Item Display" + "Sales Margin Scratchpad". */
export function CostedLinesDialog({ order, onClose }: { order: ActionOrder; onClose: () => void }) {
  const { data, error } = useFetch<CostedLines>(`/v1/orders/${order.id}/costed`);
  const [target, setTarget] = useState('');
  const t = Number(target);
  const scratch = target !== '' && Number.isFinite(t) && t >= 0 && t < 100;
  return (
    <ActionDialog title={`Costed lines — ${order.number}`} onClose={onClose} wide>
      {error && <Alert tone="error">{error}</Alert>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (
        <>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'end' }}>
            <KeyValue
              rows={[
                { label: 'Revenue (merchandise)', value: money(data.revenueCents) },
                { label: 'Cost', value: money(data.costCents) },
                { label: 'Margin', value: <strong>{money(data.marginCents)}</strong> },
                {
                  label: 'Margin %',
                  value: data.marginPct == null ? '—' : `${data.marginPct.toFixed(1)}%`,
                },
              ]}
            />
            <Field label="Scratchpad — target margin % (price each line would need)">
              <Input
                type="number"
                min={0}
                max={99}
                step="0.5"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="e.g. 45"
                data-testid="margin-target"
              />
            </Field>
          </div>
          {data.linesWithoutCost > 0 && (
            <Alert tone="warning">
              {data.linesWithoutCost} line{data.linesWithoutCost === 1 ? ' has' : 's have'} no cost
              on the catalog item — margin shown without them.
            </Alert>
          )}
          <TableWrap>
            <table className="table" data-testid="costed-table">
              <thead>
                <tr>
                  <th>Line</th>
                  <th className="num">Unit cost</th>
                  <th className="num">Cost</th>
                  <th className="num">Revenue</th>
                  <th className="num">Margin</th>
                  <th className="num">Margin %</th>
                  {scratch && <th className="num">Price @ {t}%</th>}
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      {l.description} × {l.quantity}
                    </td>
                    <td className="num">
                      {l.unitCostCents == null ? '—' : money(l.unitCostCents)}
                    </td>
                    <td className="num">{l.costCents == null ? '—' : money(l.costCents)}</td>
                    <td className="num">{money(l.revenueCents)}</td>
                    <td className="num">{l.marginCents == null ? '—' : money(l.marginCents)}</td>
                    <td className="num">
                      {l.marginPct == null ? '—' : `${l.marginPct.toFixed(1)}%`}
                    </td>
                    {scratch && (
                      <td className="num">
                        {l.unitCostCents == null
                          ? '—'
                          : money(Math.round(l.unitCostCents / (1 - t / 100)))}
                        {l.unitCostCents != null && <span className="muted"> each</span>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </>
      )}
    </ActionDialog>
  );
}

/** STORIS "Price/Spiff/Commission Table". */
export function CommissionTableDialog({
  order,
  onClose,
}: {
  order: ActionOrder;
  onClose: () => void;
}) {
  const { data, error } = useFetch<CommissionTable>(`/v1/orders/${order.id}/commission-table`);
  return (
    <ActionDialog title={`Price / Spiff / Commission — ${order.number}`} onClose={onClose} wide>
      {error && <Alert tone="error">{error}</Alert>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (
        <>
          {data.salespeople.length === 0 ? (
            <Alert tone="warning">No salesperson on this order.</Alert>
          ) : (
            <KeyValue
              rows={data.salespeople.map((sp) => ({
                label: sp.name,
                value: sp.plan
                  ? `${sp.plan.name} — ${(sp.plan.rateBps / 100).toFixed(2)}% of ${
                      sp.plan.basis === 'percent_of_margin' ? 'margin' : 'sale'
                    } · ${sp.shareBps / 100}% share`
                  : 'No commission plan assigned',
              }))}
            />
          )}
          <TableWrap>
            <table className="table" data-testid="commission-table">
              <thead>
                <tr>
                  <th>Line</th>
                  <th className="num">Merchandise</th>
                  <th className="num">Commissionable</th>
                  {data.salespeople.map((sp) => (
                    <th key={sp.membershipId} className="num">
                      {sp.name}
                    </th>
                  ))}
                  <th className="num">Spiff</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      {l.description} × {l.quantity}
                    </td>
                    <td className="num">{money(l.merchandiseCents)}</td>
                    <td className="num">{money(l.commissionableCents)}</td>
                    {l.commissionCents.map((c, i) => (
                      <td key={i} className="num">
                        {money(c)}
                      </td>
                    ))}
                    <td className="num muted">—</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Total</strong>
                  </td>
                  <td className="num">
                    <strong>{money(data.totals.merchandiseCents)}</strong>
                  </td>
                  <td />
                  {data.totals.commissionCents.map((c, i) => (
                    <td key={i} className="num">
                      <strong>{money(c)}</strong>
                    </td>
                  ))}
                  <td className="num muted">—</td>
                </tr>
              </tbody>
            </table>
          </TableWrap>
          <p className="muted" style={{ marginTop: 8 }}>
            Projected at today&apos;s plan rates; commission accrues on completion (§9). Spiffs are
            not modeled.
          </p>
        </>
      )}
    </ActionDialog>
  );
}

/** STORIS "Line Item Linked Document Display" + "View Linked Transfers" + "Purchase Order". */
export function LinkedDocsDialog({
  order,
  focus,
  onClose,
}: {
  order: ActionOrder;
  /** 'transfers' opens scrolled to the transfers; a line id focuses that line. */
  focus?: 'transfers' | 'pos' | string;
  onClose: () => void;
}) {
  const { data, error } = useFetch<LinkedDocuments>(`/v1/orders/${order.id}/linked`);
  const title =
    focus === 'transfers'
      ? 'Linked transfers'
      : focus === 'pos'
        ? 'Purchase orders'
        : 'Linked documents';
  return (
    <ActionDialog title={`${title} — ${order.number}`} onClose={onClose} wide>
      {error && <Alert tone="error">{error}</Alert>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (
        <>
          {focus !== 'transfers' &&
            data.lines
              .filter((l) => !focus || focus === 'pos' || l.id === focus)
              .map((l) => {
                const rows = [
                  ...l.purchaseOrders.map((p) => ({
                    key: `po-${p.poId}`,
                    kind: 'Purchase order',
                    ref: <Link href={`/purchase-orders/${p.poId}`}>{p.number}</Link>,
                    status: `${p.status} · ${p.allocationStatus}`,
                    detail: `${p.quantity} on order${
                      p.expectedAt ? ` · due ${p.expectedAt.slice(0, 10)}` : ''
                    }`,
                  })),
                  ...(focus === 'pos'
                    ? []
                    : [
                        ...l.deliveries.map((d) => ({
                          key: `del-${d.id}`,
                          kind: 'Delivery',
                          ref: <Link href={`/deliveries/${d.id}`}>{d.scheduledDate}</Link>,
                          status: d.status,
                          detail: `${d.quantity} unit${d.quantity === 1 ? '' : 's'}`,
                        })),
                        ...l.returns.map((r) => ({
                          key: `rma-${r.id}`,
                          kind: 'Return',
                          ref: r.rmaNumber,
                          status: r.status,
                          detail: `${r.quantity} unit${r.quantity === 1 ? '' : 's'}`,
                        })),
                      ]),
                ];
                return (
                  <div key={l.id} style={{ marginBottom: 12 }} data-testid="linked-line">
                    <strong>{l.description}</strong>
                    {rows.length === 0 ? (
                      <p className="muted" style={{ margin: '4px 0' }}>
                        {focus === 'pos'
                          ? 'No purchase order — special-order and direct-ship lines are ordered from the to-order queue.'
                          : 'No linked documents.'}
                        {focus === 'pos' && (
                          <>
                            {' '}
                            <Link href="/special-orders">Open the to-order queue →</Link>
                          </>
                        )}
                      </p>
                    ) : (
                      <TableWrap>
                        <table className="table">
                          <thead>
                            <tr>
                              <th>Document</th>
                              <th>Reference</th>
                              <th>Status</th>
                              <th>Detail</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((r) => (
                              <tr key={r.key}>
                                <td>{r.kind}</td>
                                <td>{r.ref}</td>
                                <td>{r.status}</td>
                                <td className="muted">{r.detail}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </TableWrap>
                    )}
                  </div>
                );
              })}
          {focus !== 'pos' && (
            <>
              <strong>Transfers</strong>
              {data.transfers.length === 0 ? (
                <p className="muted" style={{ margin: '4px 0' }}>
                  No stock transfers were raised for this order.
                </p>
              ) : (
                <TableWrap>
                  <table className="table" data-testid="linked-transfers">
                    <thead>
                      <tr>
                        <th>Transfer</th>
                        <th>From → To</th>
                        <th>Status</th>
                        <th>Shipped</th>
                        <th>Received</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.transfers.map((t) => (
                        <tr key={t.id}>
                          <td>
                            <Link href={`/transfers/${t.id}`}>{t.number}</Link>
                          </td>
                          <td>
                            {t.from} → {t.to}
                          </td>
                          <td>{t.status}</td>
                          <td>{t.shippedAt ? t.shippedAt.slice(0, 10) : '—'}</td>
                          <td>{t.receivedAt ? t.receivedAt.slice(0, 10) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
              {data.exchanges.length > 0 && !focus && (
                <>
                  <strong style={{ display: 'block', marginTop: 12 }}>Exchange orders</strong>
                  <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
                    {data.exchanges.map((e) => (
                      <li key={e.id}>
                        <Link href={`/orders/${e.id}`}>{e.number}</Link> · {e.status} ·{' '}
                        {e.createdAt.slice(0, 10)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </>
      )}
    </ActionDialog>
  );
}

/** STORIS "Line Stock Availability". */
export function LineStockDialog({
  order,
  lines,
  initialLineId,
  onClose,
}: {
  order: ActionOrder;
  lines: ActionLine[];
  initialLineId?: string;
  onClose: () => void;
}) {
  const [lineId, setLineId] = useState(initialLineId ?? '');
  const { data, error } = useFetch<LineStock>(
    lineId ? `/v1/orders/${order.id}/lines/${lineId}/stock` : null,
  );
  return (
    <ActionDialog title="Line stock availability" onClose={onClose}>
      <LinePicker lines={lines} value={lineId} onChange={setLineId} filter={(l) => !!l.variantId} />
      {error && <Alert tone="error">{error}</Alert>}
      {lineId && data && (
        <TableWrap>
          <table className="table" data-testid="line-stock-table">
            <thead>
              <tr>
                <th>Location</th>
                <th className="num">On hand</th>
                <th className="num">Reserved</th>
                <th className="num">Available</th>
              </tr>
            </thead>
            <tbody>
              {data.levels.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No stock record anywhere for {data.sku ?? 'this item'}.
                  </td>
                </tr>
              )}
              {data.levels.map((lv) => (
                <tr key={lv.locationId}>
                  <td>{lv.locationName}</td>
                  <td className="num">{lv.onHand}</td>
                  <td className="num">{lv.reserved}</td>
                  <td className="num">
                    <strong>{lv.available}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </ActionDialog>
  );
}

/** STORIS "Product Benefit Inquiry". */
export function ProductBenefitsDialog({
  order,
  lines,
  initialLineId,
  onClose,
}: {
  order: ActionOrder;
  lines: ActionLine[];
  initialLineId?: string;
  onClose: () => void;
}) {
  const [lineId, setLineId] = useState(initialLineId ?? '');
  const { data, error } = useFetch<LineProduct>(
    lineId ? `/v1/orders/${order.id}/lines/${lineId}/product` : null,
  );
  const attrs =
    data && data.attributes && typeof data.attributes === 'object'
      ? Object.entries(data.attributes as Record<string, unknown>)
      : [];
  return (
    <ActionDialog title="Product benefit inquiry" onClose={onClose}>
      <LinePicker lines={lines} value={lineId} onChange={setLineId} filter={(l) => !!l.variantId} />
      {error && <Alert tone="error">{error}</Alert>}
      {lineId && data && (
        <div data-testid="product-benefits">
          <KeyValue
            rows={[
              {
                label: 'Product',
                value: (
                  <Link href={`/products/${data.productId}`}>
                    <strong>{data.name}</strong>
                  </Link>
                ),
              },
              { label: 'Brand', value: data.brand ?? '—' },
              { label: 'Category', value: data.category ?? '—' },
              { label: 'SKU', value: data.sku ?? '—' },
              { label: 'Variant', value: data.variantName ?? '—' },
              { label: 'List price', value: money(data.priceCents) },
              { label: 'Status', value: data.isActive ? 'Active' : 'Inactive' },
              ...attrs.map(([k, v]) => ({ label: k, value: String(v) })),
            ]}
          />
          {(data.description || data.secondDescription) && (
            <div style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
              {data.description}
              {data.secondDescription && (
                <p className="muted" style={{ marginTop: 6 }}>
                  {data.secondDescription}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </ActionDialog>
  );
}

/** STORIS "View Order Discounts" / "View Discount Schedule Applied to this Order". */
export function OrderDiscountsDialog({
  order,
  onClose,
  onEdit,
}: {
  order: ActionOrder;
  onClose: () => void;
  onEdit?: () => void;
}) {
  const lineDiscounts = order.lines.filter((l) => l.discountCents > 0);
  return (
    <ActionDialog
      title={`Order discounts — ${order.number}`}
      onClose={onClose}
      foot={
        onEdit ? (
          <Button variant="secondary" onClick={onEdit} data-testid="discounts-edit">
            Discount multiple lines…
          </Button>
        ) : undefined
      }
    >
      <KeyValue
        rows={[
          { label: 'Order discount', value: money(order.orderDiscountCents) },
          {
            label: 'Line discounts',
            value: money(lineDiscounts.reduce((n, l) => n + l.discountCents, 0)),
          },
          { label: 'All discounts', value: <strong>{money(order.discountCents)}</strong> },
          { label: 'Discount schedule', value: 'None — automated line discounting is phase 2' },
        ]}
      />
      {lineDiscounts.length > 0 && (
        <TableWrap>
          <table className="table" data-testid="line-discounts">
            <thead>
              <tr>
                <th>Line</th>
                <th className="num">Price</th>
                <th className="num">Discount</th>
              </tr>
            </thead>
            <tbody>
              {lineDiscounts.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.description} × {l.quantity}
                  </td>
                  <td className="num">{money(l.quantity * l.unitPriceCents)}</td>
                  <td className="num">{money(l.discountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </ActionDialog>
  );
}
