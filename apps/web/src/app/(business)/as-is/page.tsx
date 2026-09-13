'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { LoadMore } from '@/components/load-more';
import { useCursorList } from '@/lib/use-cursor-list';
import {
  Alert,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Select,
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
  Toolbar,
  useListColumns,
} from '@/components/ui';
import { SecurityOverrideDialog } from '@/components/security-override-dialog';

/**
 * As-Is review queue (PLAN-POS-OPERATIONS §10): everything a return,
 * warranty, or defect intake brought back. A manager/warehouse review
 * decides each row's fate — restock into sellable inventory (the same
 * variant, or its `-AS` as-is variant), send back to the vendor, or
 * scrap. Nothing here counts as sellable stock until restocked.
 */

interface AsIsRow {
  id: string;
  variantId: string;
  productName: string | null;
  variantName: string | null;
  sku: string | null;
  locationName: string | null;
  quantity: number;
  pieceNumber: string | null;
  condition: string | null;
  asIsPriceCents: number | null;
  storageLocation: string | null;
  source: string;
  status: string;
  vendorRaNumber: string | null;
  vendorCreditCents: number | null;
  vendorCreditStatus: string | null;
  notes: string | null;
  createdAt: string;
  origin: {
    kind: 'sale' | 'order' | 'order_return' | 'stock_transfer' | 'purchase_order';
    documentId: string;
    documentNumber: string;
    rmaNumber: string | null;
    customerId: string | null;
    customerName: string | null;
    fromName: string | null;
    documentDate: string | null;
  } | null;
}

const STATUS_LABELS: Record<string, string> = {
  pending_review: 'pending review',
  restocked: 'restocked',
  vendor_return: 'vendor return',
  scrapped: 'scrapped',
};

/** Where the piece came from, with the invoice / document clickable. */
function Origin({ r }: { r: AsIsRow }) {
  const o = r.origin;
  const label = r.source.replace(/_/g, ' ');
  if (!o) {
    return (
      <span data-testid="as-is-origin">
        {label}
        <span className="muted"> · manual intake</span>
      </span>
    );
  }
  const href =
    o.kind === 'sale'
      ? `/sales/${o.documentId}`
      : o.kind === 'stock_transfer'
        ? `/transfers/${o.documentId}`
        : o.kind === 'purchase_order'
          ? `/purchase-orders/${o.documentId}`
          : `/orders/${o.documentId}`;
  const docWord =
    o.kind === 'sale'
      ? 'invoice'
      : o.kind === 'stock_transfer'
        ? 'transfer'
        : o.kind === 'purchase_order'
          ? 'PO'
          : 'order';
  return (
    <span data-testid="as-is-origin">
      <span className="capitalize">{label}</span>
      {o.rmaNumber && (
        <>
          {' '}
          <code>{o.rmaNumber}</code>
        </>
      )}
      <span className="muted"> · {docWord} </span>
      <Link href={href} data-testid="as-is-origin-link">
        <strong>{o.documentNumber}</strong>
      </Link>
      {o.documentDate && (
        <span className="muted"> ({new Date(o.documentDate).toLocaleDateString()})</span>
      )}
      {o.customerName && (
        <span className="field-hint">
          {o.customerId ? (
            <Link href={`/customers/${o.customerId}`}>{o.customerName}</Link>
          ) : (
            o.customerName
          )}
        </span>
      )}
      {o.fromName && <span className="field-hint">from {o.fromName}</span>}
    </span>
  );
}

export default function AsIsPage() {
  const [status, setStatus] = useState('pending_review');
  const [busy, setBusy] = useState(false);
  const list = useCursorList<AsIsRow>('/v1/as-is');
  const { rows, error, load: listLoad } = list;

  const load = useCallback((s: string) => listLoad(s ? { status: s } : {}), [listLoad]);

  useEffect(() => {
    void load(status);
  }, [status, load]);

  const [scrapId, setScrapId] = useState<string | null>(null);
  const [pricePending, setPricePending] = useState<{ id: string; cents: number } | null>(null);

  // The as-is selling price is manager-gated (G10), so it needs a
  // dialog that can carry both the price and a manager challenge — a
  // native prompt could do neither.
  const [pricingId, setPricingId] = useState<string | null>(null);
  const [vendorReturnId, setVendorReturnId] = useState<string | null>(null);

  async function review(
    id: string,
    action: 'restock' | 'vendor_return',
    extra: Record<string, unknown> = {},
  ) {
    setBusy(true);
    try {
      await api(`/v1/as-is/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ action, ...extra }),
      });
      toast.success(`Reviewed: ${action.replace('_', ' ')}.`);
      await load(status);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function vendorCredit(id: string, action: 'received' | 'write_off') {
    if (
      !window.confirm(action === 'received' ? 'Vendor credit received?' : 'Give up on this credit?')
    )
      return;
    setBusy(true);
    try {
      await api(`/v1/as-is/${id}/vendor-credit`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      await load(status);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Cells reach into the review dialogs and the busy flag, so the columns
  // are built here rather than at module level.
  const columns: ColumnDef<AsIsRow>[] = [
    {
      id: 'item',
      label: 'Item',
      sortValue: (r) => r.productName,
      render: (r) => (
        <>
          {r.productName ?? '(deleted)'}
          {r.variantName && <span className="muted"> — {r.variantName}</span>}
          {r.sku && (
            <>
              {' '}
              <code className="muted">{r.sku}</code>
            </>
          )}
          {r.notes && <div className="field-hint">{r.notes}</div>}
          <div className="field-hint">
            {r.pieceNumber && <code>{r.pieceNumber}</code>}
            {r.condition && <> · {r.condition.replace(/_/g, ' ')}</>}
            {r.storageLocation && <> · {r.storageLocation}</>}
            {r.asIsPriceCents != null && <> · as-is ${(r.asIsPriceCents / 100).toFixed(2)}</>}
            {r.status === 'pending_review' && (
              <>
                {' '}
                <button
                  type="button"
                  className="btn-link"
                  disabled={busy}
                  onClick={() => setPricingId(r.id)}
                >
                  price…
                </button>
              </>
            )}
          </div>
        </>
      ),
    },
    { id: 'qty', label: 'Qty', num: true, sortValue: (r) => r.quantity, render: (r) => r.quantity },
    {
      id: 'location',
      label: 'Location',
      sortValue: (r) => r.locationName,
      render: (r) => r.locationName ?? '—',
    },
    {
      id: 'origin',
      label: 'Came from',
      sortValue: (r) => (r.origin ? `${r.source} ${r.origin.documentNumber}` : r.source),
      render: (r) => <Origin r={r} />,
    },
    {
      id: 'received',
      label: 'Received',
      className: 'nowrap',
      sortValue: (r) => r.createdAt,
      render: (r) => new Date(r.createdAt).toLocaleDateString(),
    },
    {
      id: 'status',
      label: 'Status',
      sortValue: (r) => r.status,
      render: (r) => <StatusBadge status={r.status} />,
    },
    {
      id: 'actions',
      label: '',
      srLabel: 'Actions',
      className: 'actions',
      fixed: true,
      render: (r) => (
        <>
          {r.status === 'pending_review' && (
            <>
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => void review(r.id, 'restock')}
                data-testid="review-restock"
              >
                Restock
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => setVendorReturnId(r.id)}
              >
                Vendor
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                data-testid="review-scrap"
                onClick={() => setScrapId(r.id)}
              >
                Scrap
              </Button>
            </>
          )}
          {r.status === 'vendor_return' && r.vendorCreditStatus === 'open' && (
            <>
              <span className="muted">
                R/A {r.vendorRaNumber}
                {r.vendorCreditCents != null &&
                  ` · $${(r.vendorCreditCents / 100).toFixed(2)} open`}
              </span>{' '}
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void vendorCredit(r.id, 'received')}
              >
                Credit received
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void vendorCredit(r.id, 'write_off')}
              >
                Give up
              </Button>
            </>
          )}
        </>
      ),
    },
  ];
  const cols = useListColumns('as-is', columns, rows);

  return (
    <div>
      <PageHeader
        title="As-Is review"
        sub="Returned, warranty, and defect units. Nothing here is sellable until a review restocks it."
      />

      <Toolbar>
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Filter by status"
        >
          <option value="pending_review">Pending review</option>
          <option value="restocked">Restocked</option>
          <option value="vendor_return">Vendor returns</option>
          <option value="scrapped">Scrapped</option>
          <option value="">All</option>
        </Select>
      </Toolbar>

      <Stack>
        {error && <Alert tone="error">{error}</Alert>}
        {!rows && !error && <LoadingRows rows={4} />}

        {rows && (
          <Card
            flush
            description={
              <>
                Restock puts units back into the same SKU at the same location. To sell a unit as
                As-Is at a discount, restock it and adjust it onto the matching <code>-AS</code> SKU
                from <Link href="/products/stock">Stock by location</Link>. Scrapping is a
                write-off: it needs its own permission (or a manager&apos;s approval), a coded
                reason, and lands on the write-off register at cost.
              </>
            }
          >
            <TableWrap>
              <table className="table" data-testid="as-is-table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="as-is" />
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <TableEmpty colSpan={cols.ordered.length}>
                      {status
                        ? `No pieces ${STATUS_LABELS[status] ?? status.replace(/_/g, ' ')}.`
                        : 'No as-is pieces yet.'}
                    </TableEmpty>
                  )}
                  {cols.sorted.map((r) => (
                    <tr key={r.id} data-testid="as-is-row">
                      <ColumnCells list={cols} row={r} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={cols} />
            </TableWrap>
            <LoadMore state={list} noun="pieces" />
          </Card>
        )}
      </Stack>

      <SecurityOverrideDialog
        open={pricingId != null}
        title="Set the as-is selling price"
        usageClass={null}
        submitLabel="Set price"
        fields={[
          {
            name: 'price',
            label: 'As-is selling price ($)',
            type: 'number',
            step: '0.01',
            min: 0,
            required: true,
          },
        ]}
        perform={(payload) =>
          api(`/v1/as-is/${pricingId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              asIsPriceCents: Math.round(Number(payload.values?.price ?? '0') * 100),
              override: payload.override,
            }),
          }).then(() => undefined)
        }
        onClose={() => setPricingId(null)}
        onSuccess={() => void load(status)}
      />

      <SecurityOverrideDialog
        open={vendorReturnId != null}
        title="Return to vendor"
        usageClass={null}
        submitLabel="Send back"
        fields={[
          { name: 'ra', label: 'Vendor R/A number', required: true, placeholder: 'RA-…' },
          {
            name: 'credit',
            label: 'Expected vendor credit ($, blank if unknown)',
            type: 'number',
            step: '0.01',
            min: 0,
          },
        ]}
        perform={async (payload) => {
          const credit = Number(payload.values?.credit ?? '');
          await review(vendorReturnId!, 'vendor_return', {
            raNumber: (payload.values?.ra ?? '').trim(),
            ...(credit > 0 ? { expectedCreditCents: Math.round(credit * 100) } : {}),
          });
        }}
        onClose={() => setVendorReturnId(null)}
        onSuccess={() => void load(status)}
      />

      <SecurityOverrideDialog
        open={scrapId != null}
        title="Scrap — write off these units"
        usageClass="write_off"
        submitLabel="Write off"
        perform={(payload) =>
          api(`/v1/as-is/${scrapId}/review`, {
            method: 'POST',
            body: JSON.stringify({ action: 'scrap', ...payload }),
          }).then(() => undefined)
        }
        onClose={() => setScrapId(null)}
        onSuccess={() => {
          toast.success('Written off — recorded on the shrink register.');
          void load(status);
        }}
      />
    </div>
  );
}
