'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { PackageCheck, Printer, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { SecurityOverrideDialog } from '@/components/security-override-dialog';
import { LinkToPo, PoLinkBadge } from '@/components/po-links';
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
  /** Owner 2026-10-30: the origin's stock of this item right now. */
  onHandAtFrom?: number;
  reservedAtFrom?: number;
  availableAtFrom?: number;
  /** Owner 2026-10-28: the PO lines this draft line waits on. */
  poLinks?: {
    allocationId: string;
    poId: string;
    poNumber: string;
    poLineId: string;
    poStatus: string;
    expectedAt: string | null;
    quantity: number;
    status: string;
  }[];
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
  const lineColumns = isInTransit ? 7 : 6;
  const fromName = t.fromLocationName ?? 'the origin';
  const day = (v: string | null) =>
    v
      ? new Date(v.length === 10 ? `${v}T12:00:00` : v).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        })
      : null;

  const linesTable = (
    <TableWrap>
      <table className="table">
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Qty</th>
            <th>Fulfillment</th>
            <th>Inventory from</th>
            <th>Stock</th>
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
                  {(l.poLinks ?? []).length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1" data-testid="transfer-line-po">
                      {(l.poLinks ?? []).map((k) => (
                        <PoLinkBadge
                          key={k.allocationId}
                          poId={k.poId}
                          poNumber={k.poNumber}
                          poLineId={k.poLineId}
                          allocationId={k.allocationId}
                          quantity={k.quantity}
                          status={k.status}
                          canUnlink={isDraft}
                          onDone={load}
                        />
                      ))}
                    </div>
                  )}
                  {isDraft && (
                    <LinkToPo
                      variantId={l.variantId}
                      target={{ transferLineId: l.id }}
                      need={
                        (l.quantityOrdered ?? l.quantityShipped) -
                        (l.poLinks ?? [])
                          .filter((k) => k.status === 'ordered')
                          .reduce((n, k) => n + k.quantity, 0)
                      }
                      onDone={load}
                    />
                  )}
                </td>
                <td className="num" data-testid="transfer-line-qty">
                  {l.quantityOrdered ?? l.quantityShipped}
                  {l.quantityHeld > 0 && (
                    <div className="muted text-xs nowrap">{l.quantityHeld} held</div>
                  )}
                </td>
                <td data-testid="transfer-line-fulfillment">
                  <TransferLineFulfillment transfer={t} line={l} day={day} />
                </td>
                <td data-testid="transfer-line-from">
                  <div>{fromName}</div>
                  {l.availableAtFrom != null && (
                    <div
                      className={`text-xs ${l.availableAtFrom >= l.quantityShipped ? 'muted' : 'text-danger'}`}
                    >
                      {l.availableAtFrom} available
                      {(l.reservedAtFrom ?? 0) > 0 ? ` · ${l.reservedAtFrom} reserved` : ''}
                    </div>
                  )}
                </td>
                <td data-testid="transfer-line-stock">
                  <TransferLineStock transfer={t} line={l} day={day} />
                </td>
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
            <Card
              title="Lines"
              flush
              description={
                isDraft
                  ? `A draft ships once ${t.fromLocationName ?? 'the origin'} has every unit on hand: print the ticket, then Ship transfer. Until the stock is there the lines wait under Purchasing → Reorder suggestions, linked to this transfer, so the buyer can order them.`
                  : undefined
              }
            >
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

/**
 * Owner 2026-10-30: transfer lines read like sales-order lines — the
 * movement state of the units and, while it is a draft, whether the
 * origin can actually ship them. A draft holds nothing, so "in stock"
 * means Ship would find the units today; the PO links say when the
 * missing ones are due.
 */
function TransferLineFulfillment({
  transfer: t,
  line: l,
  day,
}: {
  transfer: Transfer;
  line: TransferLine;
  day: (v: string | null) => string | null;
}) {
  const remaining = l.quantityShipped - l.quantityReceived;
  let text: string;
  if (t.status === 'draft') {
    text = t.scheduledFor ? `Ships ${day(t.scheduledFor)}` : 'Draft — unscheduled';
  } else if (t.status === 'in_transit') {
    text =
      l.quantityReceived > 0 && remaining > 0
        ? `In transit · ${l.quantityReceived} of ${l.quantityShipped} received`
        : 'In transit';
  } else if (t.status === 'received') {
    text = 'Received';
  } else if (t.status === 'closed_short') {
    text = remaining > 0 ? `Closed short by ${remaining}` : 'Received';
  } else if (t.status === 'canceled') {
    text = 'Canceled';
  } else {
    text = t.status.replace(/_/g, ' ');
  }
  return (
    <div className="grid gap-0.5 text-xs">
      <span>{text}</span>
      {t.shipDirect && <span className="muted">Ship direct</span>}
      {t.route && <span className="muted">Route {t.route}</span>}
    </div>
  );
}

function TransferLineStock({
  transfer: t,
  line: l,
  day,
}: {
  transfer: Transfer;
  line: TransferLine;
  day: (v: string | null) => string | null;
}) {
  const onPo = (l.poLinks ?? []).filter((k) => k.status === 'ordered');
  const onPoUnits = onPo.reduce((n, k) => n + k.quantity, 0);
  const due =
    onPo
      .map((k) => k.expectedAt)
      .filter((d): d is string => !!d)
      .sort()[0] ?? null;
  const poNote =
    onPoUnits > 0 ? (
      <span className="muted">
        {onPoUnits} on PO{due ? ` · due ${day(due)}` : ''}
      </span>
    ) : null;
  if (t.status === 'draft') {
    const avail = l.availableAtFrom;
    if (avail == null) return <span className="muted">—</span>;
    const want = l.quantityShipped;
    const state =
      avail >= want
        ? { label: 'in stock', cls: 'badge-success' }
        : avail > 0
          ? { label: `${avail} of ${want} in stock`, cls: 'badge-warning' }
          : { label: 'not in stock', cls: 'badge-danger' };
    return (
      <div className="grid gap-0.5 text-xs">
        <span>
          <span className={`badge ${state.cls}`}>{state.label}</span>
        </span>
        {avail < want && (
          <span className="muted">
            {want - avail} short at {t.fromLocationName ?? 'the origin'}
          </span>
        )}
        {poNote}
      </div>
    );
  }
  if (t.status === 'in_transit') {
    return (
      <div className="grid gap-0.5 text-xs">
        <span>
          <span className="badge badge-neutral">{l.quantityShipped} shipped</span>
        </span>
        {poNote}
      </div>
    );
  }
  if (t.status === 'received' || t.status === 'closed_short') {
    const short = l.quantityShipped - l.quantityReceived;
    return (
      <span className={`badge ${short > 0 ? 'badge-danger' : 'badge-success'}`}>
        {short > 0 ? `${short} short` : `${l.quantityReceived} received`}
      </span>
    );
  }
  return <span className="muted">—</span>;
}
