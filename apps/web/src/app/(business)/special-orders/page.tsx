'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import { api } from '@/lib/api';
import {
  Alert,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  EmptyState,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Select,
  Stack,
  TableWrap,
  useListColumns,
} from '@/components/ui';

/**
 * The to-order queue (STORIS cutover G3): everything customers have
 * bought that the store still has to buy. Tick lines, pick the vendor,
 * generate the PO — receiving it later commits the units to the waiting
 * customers automatically and emails them.
 */

interface QueueRow {
  orderLineId: string;
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  sku: string | null;
  description: string;
  quantity: number;
  allocated: number;
  toOrder: number;
  /** 'special_order' | 'direct_ship' — direct ship POs go to the customer's door. */
  lineType: string;
}
interface VendorRow {
  id: string;
  name: string;
}

export default function SpecialOrdersPage() {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [vendorId, setVendorId] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Built inline: the select-all header and the row checkboxes read the
  // `checked` state.
  const columns: ColumnDef<QueueRow>[] = [
    {
      id: 'select',
      label: (
        <input
          type="checkbox"
          aria-label="Select all"
          checked={rows != null && rows.length > 0 && checked.size === rows.length}
          onChange={(e) =>
            setChecked(
              e.target.checked ? new Set((rows ?? []).map((r) => r.orderLineId)) : new Set(),
            )
          }
        />
      ),
      fixed: true,
      render: (r) => (
        <input
          type="checkbox"
          aria-label={`Select ${r.orderNumber} — ${r.description}`}
          checked={checked.has(r.orderLineId)}
          onChange={(e) => {
            const next = new Set(checked);
            if (e.target.checked) next.add(r.orderLineId);
            else next.delete(r.orderLineId);
            setChecked(next);
          }}
        />
      ),
    },
    {
      id: 'order',
      label: 'Order',
      sortValue: (r) => r.orderNumber,
      render: (r) => <Link href={`/orders/${r.orderId}`}>{r.orderNumber}</Link>,
    },
    {
      id: 'customer',
      label: 'Customer',
      sortValue: (r) => r.customerName,
      render: (r) => r.customerName ?? '—',
    },
    {
      id: 'item',
      label: 'Item',
      sortValue: (r) => r.description,
      render: (r) => (
        <>
          {r.description}
          {r.lineType === 'direct_ship' && (
            <>
              {' '}
              <span
                className="badge badge-info"
                title="The vendor ships this straight to the customer — its PO carries the customer's address"
              >
                direct ship
              </span>
            </>
          )}
        </>
      ),
    },
    {
      id: 'sku',
      label: 'SKU',
      sortValue: (r) => r.sku,
      render: (r) => <code>{r.sku ?? '—'}</code>,
    },
    {
      id: 'quantity',
      label: 'Qty',
      num: true,
      sortValue: (r) => r.quantity,
      render: (r) => r.quantity,
    },
    {
      id: 'allocated',
      label: 'On PO',
      num: true,
      sortValue: (r) => r.allocated,
      render: (r) => r.allocated,
    },
    {
      id: 'toOrder',
      label: 'To order',
      num: true,
      sortValue: (r) => r.toOrder,
      render: (r) => <strong>{r.toOrder}</strong>,
    },
  ];
  const cols = useListColumns('special-orders', columns, rows);

  async function load() {
    try {
      const [queue, vend] = await Promise.all([
        api<QueueRow[]>('/v1/special-orders/queue'),
        api<{ data: VendorRow[] } | VendorRow[]>('/v1/vendors').catch(() => []),
      ]);
      setRows(queue);
      const vlist = Array.isArray(vend) ? vend : (vend.data ?? []);
      setVendors(vlist);
      if (vlist[0] && !vendorId) setVendorId(vlist[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(
    () => rows?.filter((r) => checked.has(r.orderLineId)) ?? [],
    [rows, checked],
  );

  async function generate() {
    if (!vendorId || selected.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ number: string; lineCount: number }>(
        '/v1/special-orders/generate-po',
        {
          method: 'POST',
          body: JSON.stringify({
            vendorId,
            lines: selected.map((r) => ({ orderLineId: r.orderLineId, quantity: r.toOrder })),
          }),
        },
      );
      setMessage(`Created ${res.number} with ${res.lineCount} line(s).`);
      setChecked(new Set());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Special orders to buy"
        sub="Receiving the PO later commits the arrived units to these customers automatically and emails them that their item is in."
        actions={
          <>
            <Select
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
              aria-label="Vendor to order from"
            >
              {vendors.length === 0 && <option value="">No vendors yet</option>}
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              onClick={() => void generate()}
              disabled={busy || !vendorId || selected.length === 0}
              data-testid="generate-po"
            >
              <FileText size={14} aria-hidden />
              Generate PO ({selected.length})
            </Button>
          </>
        }
      />
      <Stack>
        {error && <Alert tone="error">{error}</Alert>}
        {message && <Alert tone="success">{message}</Alert>}

        {!rows && !error && <LoadingRows rows={4} />}
        {rows && rows.length === 0 && (
          <EmptyState title="Queue is clear">
            Every special order is on a PO or fulfilled.
          </EmptyState>
        )}
        {rows && rows.length > 0 && (
          <Card flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="special-orders" />
                </thead>
                <tbody>
                  {cols.sorted.map((r) => (
                    <tr key={r.orderLineId}>
                      <ColumnCells list={cols} row={r} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={cols} />
            </TableWrap>
          </Card>
        )}
      </Stack>
    </div>
  );
}
