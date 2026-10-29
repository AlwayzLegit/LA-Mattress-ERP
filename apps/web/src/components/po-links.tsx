'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button, Input, Select } from '@/components/ui';

/**
 * Owner 2026-10-28: purchase-order links made and undone by hand. A PO
 * line can be tied to a sales-order line or a draft transfer line
 * (from the PO page), and an order or transfer line can pick the open
 * PO line it waits on (from its own page). The link is the same
 * `po_line_allocations` row the special-order loop writes: the receipt
 * commits the units to the order (or marks them arrived for the
 * transfer), and everything that reads "waiting on PO" sees it.
 */

export interface OpenPoLine {
  poLineId: string;
  poId: string;
  poNumber: string;
  poStatus: string;
  vendorName: string | null;
  locationName: string | null;
  expectedAt: string | null;
  quantityOrdered: number;
  quantityAccepted: number;
  free: number;
}

interface LinkCandidates {
  poLine: { id: string; variantId: string; sku: string | null; free: number };
  orders: {
    orderLineId: string;
    orderId: string;
    orderNumber: string;
    customerName: string | null;
    promisedDate: string | null;
    description: string;
    lineType: string;
    need: number;
  }[];
  transfers: {
    transferLineId: string;
    transferId: string;
    transferNumber: string;
    toLocationName: string | null;
    scheduledFor: string | null;
    need: number;
  }[];
}

function day(value: string | null): string {
  if (!value) return '';
  return new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

/** Undo one link whose units are still on order. */
export async function unlinkPo(args: {
  poId: string;
  poLineId: string;
  allocationId: string;
}): Promise<void> {
  await api(`/v1/purchase-orders/${args.poId}/lines/${args.poLineId}/links/${args.allocationId}`, {
    method: 'DELETE',
  });
}

/** From the PO page: tie this PO line to an order or transfer line. */
export function LinkFromPo({
  poId,
  poLineId,
  free,
  onDone,
}: {
  poId: string;
  poLineId: string;
  /** Units of the PO line no link covers yet. */
  free: number;
  onDone: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [cands, setCands] = useState<LinkCandidates | null>(null);
  const [target, setTarget] = useState('');
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCands(null);
    void api<LinkCandidates>(`/v1/purchase-orders/${poId}/lines/${poLineId}/link-candidates`)
      .then((c) => {
        setCands(c);
        const first = c.orders[0]
          ? `o:${c.orders[0].orderLineId}`
          : c.transfers[0]
            ? `t:${c.transfers[0].transferLineId}`
            : '';
        setTarget(first);
        setQty(1);
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
  }, [open, poId, poLineId]);

  if (free <= 0) return null;
  if (!open) {
    return (
      <button
        type="button"
        className="btn-link text-xs"
        onClick={() => setOpen(true)}
        data-testid="po-link-open"
      >
        Link to an order or transfer…
      </button>
    );
  }
  const need = (() => {
    if (!cands) return 0;
    const [kind, id] = target.split(':');
    if (kind === 'o') return cands.orders.find((o) => o.orderLineId === id)?.need ?? 0;
    if (kind === 't') return cands.transfers.find((t) => t.transferLineId === id)?.need ?? 0;
    return 0;
  })();
  const max = Math.max(0, Math.min(free, need));

  async function submit() {
    const [kind, id] = target.split(':');
    if (!id) return;
    setBusy(true);
    try {
      await api(`/v1/purchase-orders/${poId}/lines/${poLineId}/links`, {
        method: 'POST',
        body: JSON.stringify(
          kind === 'o' ? { orderLineId: id, quantity: qty } : { transferLineId: id, quantity: qty },
        ),
      });
      toast.success('Linked — the receipt will commit the units.');
      setOpen(false);
      await onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1 flex flex-wrap items-end gap-2 text-xs" data-testid="po-link-form">
      <label className="grid gap-0.5">
        <span className="muted">Link to</span>
        <Select
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            setQty(1);
          }}
          aria-label="Link to"
          data-testid="po-link-target"
          className="max-w-[360px]"
        >
          {!cands && <option value="">Loading…</option>}
          {cands && cands.orders.length === 0 && cands.transfers.length === 0 && (
            <option value="">Nothing of this item is waiting</option>
          )}
          {cands && cands.orders.length > 0 && (
            <optgroup label="Sales orders">
              {cands.orders.map((o) => (
                <option key={o.orderLineId} value={`o:${o.orderLineId}`}>
                  {o.orderNumber}
                  {o.customerName ? ` · ${o.customerName}` : ''}
                  {o.promisedDate ? ` · ${day(o.promisedDate)}` : ''} · needs {o.need}
                </option>
              ))}
            </optgroup>
          )}
          {cands && cands.transfers.length > 0 && (
            <optgroup label="Draft transfers">
              {cands.transfers.map((t) => (
                <option key={t.transferLineId} value={`t:${t.transferLineId}`}>
                  {t.transferNumber}
                  {t.toLocationName ? ` → ${t.toLocationName}` : ''}
                  {t.scheduledFor ? ` · ${day(t.scheduledFor)}` : ''} · needs {t.need}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </label>
      <label className="grid gap-0.5">
        <span className="muted">Qty</span>
        <Input
          type="number"
          min={1}
          max={max || 1}
          value={qty}
          onChange={(e) => setQty(Math.max(1, Math.min(max || 1, Number(e.target.value) || 1)))}
          aria-label="Quantity to link"
          data-testid="po-link-qty"
          className="w-16"
        />
      </label>
      <Button
        type="button"
        size="sm"
        variant="primary"
        disabled={busy || !target || max <= 0}
        onClick={() => void submit()}
        data-testid="po-link-submit"
      >
        Link
      </Button>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={() => setOpen(false)}
      >
        Cancel
      </Button>
    </div>
  );
}

/** From an order or transfer line: pick the open PO line it waits on. */
export function LinkToPo({
  variantId,
  target,
  need,
  onDone,
  label = 'Link to a PO…',
}: {
  variantId: string;
  target: { orderLineId: string } | { transferLineId: string };
  /** Units the line still needs no PO covers. */
  need: number;
  onDone: () => Promise<void> | void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<OpenPoLine[] | null>(null);
  const [poLineId, setPoLineId] = useState('');
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLines(null);
    void api<OpenPoLine[]>(`/v1/purchase-orders/open-lines?variantId=${variantId}`)
      .then((l) => {
        setLines(l);
        setPoLineId(l[0]?.poLineId ?? '');
        setQty(1);
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
  }, [open, variantId]);

  if (need <= 0) return null;
  if (!open) {
    return (
      <button
        type="button"
        className="btn-link text-left text-xs"
        onClick={() => setOpen(true)}
        data-testid="link-to-po-open"
      >
        {label}
      </button>
    );
  }
  const chosen = lines?.find((l) => l.poLineId === poLineId) ?? null;
  const max = Math.max(0, Math.min(need, chosen?.free ?? 0));

  async function submit() {
    if (!chosen) return;
    setBusy(true);
    try {
      await api(`/v1/purchase-orders/${chosen.poId}/lines/${chosen.poLineId}/links`, {
        method: 'POST',
        body: JSON.stringify({ ...target, quantity: qty }),
      });
      toast.success(`Linked to ${chosen.poNumber}.`);
      setOpen(false);
      await onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1 flex flex-wrap items-end gap-2 text-xs" data-testid="link-to-po-form">
      <label className="grid gap-0.5">
        <span className="muted">Purchase order</span>
        <Select
          value={poLineId}
          onChange={(e) => {
            setPoLineId(e.target.value);
            setQty(1);
          }}
          aria-label="Purchase order"
          data-testid="link-to-po-target"
          className="max-w-[360px]"
        >
          {!lines && <option value="">Loading…</option>}
          {lines && lines.length === 0 && <option value="">No open PO carries this item</option>}
          {lines?.map((l) => (
            <option key={l.poLineId} value={l.poLineId}>
              {l.poNumber}
              {l.vendorName ? ` · ${l.vendorName}` : ''}
              {l.locationName ? ` → ${l.locationName}` : ''}
              {l.expectedAt ? ` · due ${day(l.expectedAt)}` : ''} · {l.free} free
            </option>
          ))}
        </Select>
      </label>
      <label className="grid gap-0.5">
        <span className="muted">Qty</span>
        <Input
          type="number"
          min={1}
          max={max || 1}
          value={qty}
          onChange={(e) => setQty(Math.max(1, Math.min(max || 1, Number(e.target.value) || 1)))}
          aria-label="Quantity to link"
          data-testid="link-to-po-qty"
          className="w-16"
        />
      </label>
      <Button
        type="button"
        size="sm"
        variant="primary"
        disabled={busy || !chosen || max <= 0}
        onClick={() => void submit()}
        data-testid="link-to-po-submit"
      >
        Link
      </Button>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={() => setOpen(false)}
      >
        Cancel
      </Button>
    </div>
  );
}

/** One linked PO, with Unlink while its units are still on order. */
export function PoLinkBadge({
  poId,
  poNumber,
  poLineId,
  allocationId,
  quantity,
  status,
  canUnlink,
  onDone,
}: {
  poId: string;
  poNumber: string;
  poLineId: string;
  allocationId: string;
  quantity: number;
  status: string;
  canUnlink: boolean;
  onDone: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <span className="inline-flex items-center gap-1" data-testid="po-link-badge">
      <Link href={`/purchase-orders/${poId}`} className="badge badge-info no-underline">
        {poNumber} ×{quantity}
        {status === 'received' ? ' · received' : ''}
      </Link>
      {canUnlink && status === 'ordered' && (
        <button
          type="button"
          className="btn-link text-xs"
          disabled={busy}
          title="Unlink — the units go back to the PO's free pool"
          aria-label={`Unlink ${poNumber}`}
          data-testid="po-unlink"
          onClick={async () => {
            if (
              !confirm(`Unlink ${poNumber}? Its ${quantity} unit(s) go back to the PO's free pool.`)
            )
              return;
            setBusy(true);
            try {
              await unlinkPo({ poId, poLineId, allocationId });
              toast.success(`Unlinked ${poNumber}.`);
              await onDone();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}
