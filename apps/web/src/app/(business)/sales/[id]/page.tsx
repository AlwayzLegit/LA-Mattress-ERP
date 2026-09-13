'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Printer, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Money } from '@/components/money';
import { PrintableReceipt, type ReceiptBusiness } from '@/components/printable-receipt';
import {
  Alert,
  BackLink,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  Field,
  FormActions,
  FormGrid,
  Input,
  KeyValue,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
  useListColumns,
} from '@/components/ui';

interface SaleLine {
  id: string;
  variantId: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  totalCents: number;
  refundedQuantity: number;
}
interface Payment {
  id: string;
  method: string;
  amountCents: number;
  status: string;
}
interface Refund {
  id: string;
  amountCents: number;
  reason: string | null;
  createdAt: string;
}
interface Sale {
  id: string;
  number: string;
  status: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  customerId: string | null;
  notes: string | null;
  completedAt: string | null;
  createdAt: string;
  lines: SaleLine[];
  payments: Payment[];
  refunds: Refund[];
}

const REFUND_COLUMNS: ColumnDef<Refund>[] = [
  {
    id: 'when',
    label: 'When',
    className: 'nowrap',
    sortValue: (r) => r.createdAt,
    render: (r) => new Date(r.createdAt).toLocaleString(),
  },
  {
    id: 'amount',
    label: 'Amount',
    num: true,
    sortValue: (r) => r.amountCents,
    render: (r) => (
      <strong>
        <Money cents={r.amountCents} />
      </strong>
    ),
  },
  {
    id: 'reason',
    label: 'Reason',
    sortValue: (r) => r.reason,
    render: (r) => r.reason ?? <span className="muted">—</span>,
  },
];

export default function SaleDetailPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [sale, setSale] = useState<Sale | null>(null);
  const [business, setBusiness] = useState<ReceiptBusiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refundQty, setRefundQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const refundCols = useListColumns('sale-refunds', REFUND_COLUMNS, sale?.refunds ?? null);

  async function load() {
    try {
      setSale(await api<Sale>(`/v1/sales/${id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    void load();
    void api<{
      name: string;
      receiptHeader: string | null;
      receiptFooter: string | null;
      branding?: { publicName?: string | null } | null;
    }>('/v1/business/settings/pos')
      .then((s) =>
        setBusiness({
          name: s.branding?.publicName ?? s.name,
          receiptHeader: s.receiptHeader,
          receiptFooter: s.receiptFooter,
        }),
      )
      .catch(() => {
        // Print receipt will fall back to "Sale" as the header.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function submitRefund() {
    if (!sale) return;
    const lines = Object.entries(refundQty)
      .filter(([, q]) => q > 0)
      .map(([saleLineId, quantity]) => ({ saleLineId, quantity }));
    if (lines.length === 0) {
      toast.error('Select at least one line and a quantity to refund.');
      return;
    }
    setBusy(true);
    try {
      await api(`/v1/sales/${id}/refund`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason || null, lines }),
      });
      setRefundQty({});
      setReason('');
      toast.success('Refund processed.');
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div>
        <PageHeader title="Sale not found" eyebrow={<BackLink href="/sales">All sales</BackLink>} />
        <Alert tone="error">{error}</Alert>
      </div>
    );
  }
  if (!sale) return <LoadingRows rows={4} />;

  const refundable = sale.status === 'completed' || sale.status === 'partially_refunded';
  const lineCols = refundable ? 6 : 5;

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/sales">All sales</BackLink>}
        title={<code>{sale.number}</code>}
        meta={<StatusBadge status={sale.status} />}
        sub={new Date(sale.completedAt ?? sale.createdAt).toLocaleString()}
        actions={
          <Button
            variant="primary"
            className="inline-flex items-center gap-1.5"
            onClick={() => window.print()}
          >
            <Printer size={14} /> Print receipt
          </Button>
        }
      />
      <PrintableReceipt
        sale={{
          number: sale.number,
          completedAt: sale.completedAt,
          createdAt: sale.createdAt,
          subtotalCents: sale.subtotalCents,
          discountCents: sale.discountCents,
          taxCents: sale.taxCents,
          totalCents: sale.totalCents,
          lines: sale.lines.map((l) => ({
            description: l.description,
            quantity: l.quantity,
            totalCents: l.totalCents,
          })),
          payments: sale.payments,
        }}
        business={business}
      />

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Stack>
          <Card title="Lines" flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Sold</th>
                    <th className="num">Refunded</th>
                    <th className="num">Unit</th>
                    <th className="num">Total</th>
                    {refundable && <th className="num">Refund qty</th>}
                  </tr>
                </thead>
                <tbody>
                  {sale.lines.map((l) => {
                    const remaining = l.quantity - l.refundedQuantity;
                    return (
                      <tr key={l.id}>
                        <td>{l.description}</td>
                        <td className="num">{l.quantity}</td>
                        <td className="num">{l.refundedQuantity}</td>
                        <td className="num">
                          <Money cents={l.unitPriceCents} />
                        </td>
                        <td className="num">
                          <Money cents={l.totalCents} />
                        </td>
                        {refundable && (
                          <td className="num">
                            {remaining > 0 ? (
                              <input
                                type="number"
                                min={0}
                                max={remaining}
                                className="input w-16"
                                aria-label={`Refund quantity for ${l.description}`}
                                value={refundQty[l.id] ?? 0}
                                onChange={(e) =>
                                  setRefundQty((prev) => ({
                                    ...prev,
                                    [l.id]: Math.max(
                                      0,
                                      Math.min(remaining, Number(e.target.value) || 0),
                                    ),
                                  }))
                                }
                              />
                            ) : (
                              <span className="muted">fully refunded</span>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                  {sale.lines.length === 0 && (
                    <TableEmpty colSpan={lineCols}>This sale has no lines.</TableEmpty>
                  )}
                </tbody>
              </table>
            </TableWrap>
          </Card>

          {refundable && (
            <Card
              title="New refund"
              description="Set a quantity in the table above for the lines you want to refund. Inventory is restored automatically."
            >
              <FormGrid cols={2}>
                <Field label="Reason (optional)" className="form-span">
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
              </FormGrid>
              <FormActions>
                <Button
                  variant="primary"
                  onClick={submitRefund}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5"
                >
                  <RotateCcw size={14} /> {busy ? 'Processing…' : 'Process refund'}
                </Button>
              </FormActions>
            </Card>
          )}
        </Stack>

        <Stack>
          <Card title="Totals">
            <KeyValue
              rows={[
                { label: 'Subtotal', value: <Money cents={sale.subtotalCents} /> },
                ...(sale.discountCents > 0
                  ? [{ label: 'Discount', value: <Money cents={-sale.discountCents} /> }]
                  : []),
                { label: 'Tax', value: <Money cents={sale.taxCents} /> },
                {
                  label: <strong>Total</strong>,
                  value: (
                    <strong>
                      <Money cents={sale.totalCents} />
                    </strong>
                  ),
                },
              ]}
            />
          </Card>

          <Card title="Payments">
            {sale.payments.length === 0 ? (
              <p className="muted">No payments recorded.</p>
            ) : (
              <KeyValue
                rows={sale.payments.map((p) => ({
                  label: `${p.method.toUpperCase()} (${p.status})`,
                  value: <Money cents={p.amountCents} />,
                }))}
              />
            )}
          </Card>

          {sale.refunds.length > 0 && (
            <Card title="Refunds" flush>
              <TableWrap>
                <table className="table table-dense">
                  <thead>
                    <ColumnHeadRow list={refundCols} testIdPrefix="sale-refunds" />
                  </thead>
                  <tbody>
                    {refundCols.sorted.map((r) => (
                      <tr key={r.id}>
                        <ColumnCells list={refundCols} row={r} />
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ResetColumns list={refundCols} />
              </TableWrap>
            </Card>
          )}
        </Stack>
      </div>
    </div>
  );
}
