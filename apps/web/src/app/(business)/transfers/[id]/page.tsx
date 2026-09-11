'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { PackageCheck, Printer, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { SecurityOverrideDialog } from '@/components/security-override-dialog';
import {
  Alert,
  BackLink,
  Button,
  Card,
  FormActions,
  Input,
  KeyValue,
  LinkButton,
  LoadingRows,
  PageHeader,
  Stack,
  StatusBadge,
  TableWrap,
} from '@/components/ui';

interface TransferLine {
  id: string;
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  quantityShipped: number;
  quantityReceived: number;
  quantityOrdered: number | null;
  quantityHeld: number;
}
interface Transfer {
  id: string;
  number: string;
  status: string;
  fromLocationName: string | null;
  toLocationName: string | null;
  ticketPrintedAt: string | null;
  ticketPrintCount: number;
  manifestId: string | null;
  manifestNumber: string | null;
  loadNumber: number | null;
  shippedAt: string | null;
  receivedAt: string | null;
  canceledAt: string | null;
  notes: string | null;
  createdAt: string;
  // A22 slice 2
  scheduledFor: string | null;
  reasonCode: { code: string; description: string } | null;
  route: string | null;
  shipDirect: boolean;
  fulfillmentInstructions: string | null;
  lines: TransferLine[];
}

export default function TransferDetailPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [t, setT] = useState<Transfer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recvQty, setRecvQty] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setT(await api<Transfer>(`/v1/stock-transfers/${id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const [closeShortOpen, setCloseShortOpen] = useState(false);

  async function ship() {
    setBusy(true);
    try {
      await api(`/v1/stock-transfers/${id}/ship`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitReceive() {
    if (!t) return;
    const lines = Object.entries(recvQty)
      .filter(([, q]) => q > 0)
      .map(([lineId, quantity]) => ({ lineId, quantity }));
    if (lines.length === 0) {
      toast.error('Enter a quantity on at least one line.');
      return;
    }
    setBusy(true);
    try {
      await api(`/v1/stock-transfers/${id}/receive`, {
        method: 'POST',
        body: JSON.stringify({ lines }),
      });
      setRecvQty({});
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!confirm('Cancel this transfer? Only allowed before shipping.')) return;
    setBusy(true);
    try {
      await api(`/v1/stock-transfers/${id}/cancel`, { method: 'POST' });
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const back = <BackLink href="/transfers">All transfers</BackLink>;

  if (error && !t) {
    return (
      <div>
        <PageHeader eyebrow={back} title="Transfer not found" />
        <Alert tone="error">{error}</Alert>
      </div>
    );
  }
  if (!t) return <LoadingRows rows={5} />;

  const isDraft = t.status === 'draft';
  const isInTransit = t.status === 'in_transit';
  const hasShortfall = t.lines.some((l) => l.quantityShipped > l.quantityReceived);
  const lineColumns = isInTransit ? 5 : 4;

  const linesTable = (
    <TableWrap>
      <table className="table">
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Shipped</th>
            <th className="num">Held</th>
            <th className="num">Received</th>
            {isInTransit && <th className="num">Receive qty</th>}
          </tr>
        </thead>
        <tbody>
          {t.lines.length === 0 && (
            <tr>
              <td colSpan={lineColumns} className="table-empty">
                This transfer has no lines.
              </td>
            </tr>
          )}
          {t.lines.map((l) => {
            const remaining = l.quantityShipped - l.quantityReceived;
            return (
              <tr key={l.id}>
                <td>
                  {l.productName}
                  {l.variantName && <span className="muted"> — {l.variantName}</span>}
                  {l.sku && (
                    <>
                      {' '}
                      <code className="muted">{l.sku}</code>
                    </>
                  )}
                </td>
                <td className="num">{l.quantityShipped}</td>
                <td className="num">{l.quantityHeld > 0 ? l.quantityHeld : '—'}</td>
                <td className="num">{l.quantityReceived}</td>
                {isInTransit && (
                  <td className="num">
                    {remaining > 0 ? (
                      <Input
                        type="number"
                        min={0}
                        max={remaining}
                        aria-label={`Receive quantity for ${l.productName}`}
                        value={recvQty[l.id] ?? 0}
                        onChange={(e) =>
                          setRecvQty((prev) => ({
                            ...prev,
                            [l.id]: Math.max(0, Math.min(remaining, Number(e.target.value) || 0)),
                          }))
                        }
                        className="w-20"
                      />
                    ) : (
                      <span className="badge badge-success">complete</span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );

  return (
    <div>
      <PageHeader
        eyebrow={back}
        title={<code>{t.number}</code>}
        meta={<StatusBadge status={t.status} />}
        sub={
          <>
            <strong>{t.fromLocationName ?? '—'}</strong> →{' '}
            <strong>{t.toLocationName ?? '—'}</strong> · created{' '}
            {new Date(t.createdAt).toLocaleString()}
          </>
        }
        actions={
          <>
            <LinkButton
              href={`/print/transfers/${id}`}
              variant="secondary"
              size="sm"
              target="_blank"
              data-testid="print-transfer-ticket"
            >
              <Printer size={13} aria-hidden /> Transfer ticket
            </LinkButton>
            {isDraft && (
              <>
                <Button variant="danger" size="sm" onClick={cancel} disabled={busy}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={ship} disabled={busy}>
                  <Truck size={14} aria-hidden />
                  {busy ? 'Shipping…' : 'Ship transfer'}
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Stack>
          {isInTransit ? (
            <Card
              title="Lines"
              description="Enter what arrived on each line. Sent units that never arrive can't be dismissed — “Close short” writes the shortfall off at cost (manager approval + coded reason) and registers the variance."
            >
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitReceive();
                }}
              >
                {linesTable}
                <FormActions
                  start={
                    hasShortfall && (
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        disabled={busy}
                        data-testid="close-short"
                        onClick={() => setCloseShortOpen(true)}
                      >
                        Close short…
                      </Button>
                    )
                  }
                >
                  <Button type="submit" variant="primary" disabled={busy}>
                    <PackageCheck size={14} aria-hidden />
                    {busy ? 'Receiving…' : 'Record receipt'}
                  </Button>
                </FormActions>
              </form>
            </Card>
          ) : (
            <Card title="Lines" flush>
              {linesTable}
            </Card>
          )}
        </Stack>

        <Stack>
          <Card title="Details">
            <KeyValue
              rows={[
                { label: 'From', value: t.fromLocationName ?? '—' },
                { label: 'To', value: t.toLocationName ?? '—' },
                {
                  label: 'Reason',
                  value: t.reasonCode ? `${t.reasonCode.code} — ${t.reasonCode.description}` : '—',
                },
                { label: 'Route', value: t.route ?? '—' },
                { label: 'Delivery date', value: t.scheduledFor ?? '—' },
                { label: 'Ship direct', value: t.shipDirect ? 'Yes' : 'No' },
                {
                  label: 'Fulfillment instructions',
                  value: t.fulfillmentInstructions ?? '—',
                },
                {
                  label: 'Manifest',
                  value: t.manifestId ? (
                    <>
                      <Link href={`/transfers/manifests/${t.manifestId}`}>
                        <code>{t.manifestNumber}</code>
                      </Link>
                      {t.loadNumber != null ? ` (load ${t.loadNumber})` : ''}
                      {isDraft && (
                        <span className="muted"> — ships when the manifest completes</span>
                      )}
                    </>
                  ) : (
                    '—'
                  ),
                },
                {
                  // Q3: shipping is gated on a printed ticket by default.
                  label: 'Ticket',
                  value: t.ticketPrintedAt
                    ? `Printed ${new Date(t.ticketPrintedAt).toLocaleString()}${t.ticketPrintCount > 1 ? ` (×${t.ticketPrintCount})` : ''}`
                    : isDraft
                      ? 'Not printed yet — print it before shipping'
                      : 'Not printed',
                },
                {
                  label: 'Shipped',
                  value: t.shippedAt ? new Date(t.shippedAt).toLocaleString() : '—',
                },
                {
                  label: 'Received',
                  value: t.receivedAt ? new Date(t.receivedAt).toLocaleString() : '—',
                },
                ...(t.canceledAt
                  ? [{ label: 'Cancelled', value: new Date(t.canceledAt).toLocaleString() }]
                  : []),
              ]}
            />
          </Card>
          {t.notes && (
            <Card title="Notes">
              <p className="muted">{t.notes}</p>
            </Card>
          )}
        </Stack>
      </div>

      <SecurityOverrideDialog
        open={closeShortOpen}
        title={`Close ${t.number} short — write off the missing units`}
        usageClass="transfer_variance"
        submitLabel="Close short"
        perform={(payload) =>
          api(`/v1/stock-transfers/${id}/close-short`, {
            method: 'POST',
            body: JSON.stringify(payload),
          }).then(() => undefined)
        }
        onClose={() => setCloseShortOpen(false)}
        onSuccess={() => {
          toast.success('Closed short — variance registered.');
          void load();
        }}
      />
    </div>
  );
}
