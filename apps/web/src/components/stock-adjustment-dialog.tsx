'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { ModalDialog } from '@/components/modal-dialog';
import { Money } from '@/components/money';
import { fmtDay, type ReservationBoard } from '@/components/reassign-reservation-dialog';
import {
  SecurityOverrideDialog,
  type OverridePayload,
} from '@/components/security-override-dialog';
import {
  Alert,
  Button,
  Field,
  FormActions,
  FormGrid,
  Input,
  LoadingRows,
  Select,
  StatGrid,
  StatTile,
  StatusBadge,
  TableEmpty,
  TableWrap,
} from '@/components/ui';

/**
 * STORIS "Stock Adjustment" (A22 slice 3): one dialog for every way a
 * unit changes state without a document — the header strip shows what
 * is here (on hand / reserved / floor / available / on PO / as-is /
 * bin) and the tabs mirror the STORIS screen: Quantity, Bin to bin,
 * Move to As-Is, Move from As-Is, As-Is status, As-Is adjustment,
 * Write-off, Change serial, SO info. Reason-gated actions (a write-off,
 * a restricted as-is code, an as-is price) run through the Security
 * Override dialog so a manager can approve them in place.
 */

export interface StockCard {
  variantId: string;
  productId: string;
  productName: string;
  sku: string | null;
  serialTracked: boolean;
  costCents: number | null;
  locationId: string;
  locationName: string;
  onHand: number;
  reserved: number;
  floorSample: number;
  available: number;
  netOnPo: number;
  totalPo: number;
  asIsOnHand: number;
  asIsAvailable: number;
  asIsNonSellable: number;
  layawayReserved: number;
  onOrderReserved: number;
  storageBinId: string | null;
  storageBinCode: string | null;
  asIsVariantId: string | null;
  asIsPieces: {
    id: string;
    pieceNumber: string | null;
    condition: string | null;
    storageLocation: string | null;
    asIsPriceCents: number | null;
    source: string;
    createdAt: string;
  }[];
  serials: { id: string; serial: string; status: string }[];
  bins: { id: string; code: string }[];
}

export const STOCK_ADJUSTMENT_TABS = [
  { key: 'quantity', label: 'Quantity' },
  { key: 'bin', label: 'Bin to bin' },
  { key: 'to_as_is', label: 'Move to As-Is' },
  { key: 'from_as_is', label: 'Move from As-Is' },
  { key: 'as_is_status', label: 'As-Is status' },
  { key: 'as_is_adjust', label: 'As-Is adjustment' },
  { key: 'write_off', label: 'Write-off' },
  { key: 'serial', label: 'Change serial' },
  { key: 'so_info', label: 'SO info' },
] as const;
export type StockAdjustmentTab = (typeof STOCK_ADJUSTMENT_TABS)[number]['key'];

const ADJUST_BUCKETS = [
  { key: 'count_correction', label: 'Count correction' },
  { key: 'damage', label: 'Damage' },
  { key: 'theft', label: 'Theft / shrink' },
  { key: 'other', label: 'Other' },
] as const;
const CONDITIONS = ['like_new', 'light_wear', 'damaged', 'parts'] as const;

interface ReasonCode {
  id: string;
  code: string;
  description: string;
  isRestricted?: boolean;
}

interface OverrideRequest {
  title: string;
  usageClass: string | null;
  submitLabel: string;
  perform: (payload: OverridePayload) => Promise<void>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function useReasonCodes(usageClass: string | null): ReasonCode[] {
  const [codes, setCodes] = useState<ReasonCode[]>([]);
  useEffect(() => {
    if (!usageClass) return;
    api<ReasonCode[]>(`/v1/reason-codes?usageClass=${usageClass}`)
      .then(setCodes)
      .catch(() => setCodes([]));
  }, [usageClass]);
  return codes;
}

function pieceLabel(p: StockCard['asIsPieces'][number]): string {
  return `${p.pieceNumber ?? p.id.slice(0, 8)}${p.condition ? ` · ${p.condition}` : ''}${p.storageLocation ? ` · ${p.storageLocation}` : ''}`;
}

/** Shared per-tab plumbing: the card, a refresh, the "something changed" hook and the override hand-off. */
interface TabProps {
  card: StockCard;
  busy: boolean;
  run: (fn: () => Promise<void>, done?: string) => Promise<void>;
  requestOverride: (req: OverrideRequest) => void;
}

export function StockAdjustmentDialog({
  open,
  variantId,
  locationId,
  initialTab = 'quantity',
  onClose,
  onChanged,
  onReassign,
}: {
  open: boolean;
  variantId: string;
  locationId: string;
  initialTab?: StockAdjustmentTab;
  onClose: () => void;
  /** Stock changed — the caller refreshes its own numbers. */
  onChanged?: () => void;
  /** Open the Reassign Reservation dialog for the same item (SO info tab). */
  onReassign?: () => void;
}) {
  const [card, setCard] = useState<StockCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<StockAdjustmentTab>(initialTab);
  const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState<OverrideRequest | null>(null);

  const load = useCallback(async () => {
    try {
      setCard(
        await api<StockCard>(
          `/v1/inventory/stock-card?variantId=${variantId}&locationId=${locationId}`,
        ),
      );
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [variantId, locationId]);

  useEffect(() => {
    if (!open) {
      setCard(null);
      setOverride(null);
      return;
    }
    setTab(initialTab);
    void load();
  }, [open, initialTab, load]);

  const run = useCallback(
    async (fn: () => Promise<void>, done?: string) => {
      setBusy(true);
      try {
        await fn();
        if (done) toast.success(done);
        await load();
        onChanged?.();
      } catch (err) {
        toast.error(errorText(err));
      } finally {
        setBusy(false);
      }
    },
    [load, onChanged],
  );

  if (!open) return null;

  const title = card
    ? `Stock adjustment — ${card.sku ?? card.productName} @ ${card.locationName}`
    : 'Stock adjustment';
  const visibleTabs = STOCK_ADJUSTMENT_TABS.filter(
    (t) => t.key !== 'serial' || (card?.serialTracked ?? false),
  );

  return (
    <>
      <ModalDialog title={title} onClose={onClose} wide testId="stock-adjustment-dialog">
        {error && <Alert tone="error">{error}</Alert>}
        {!card ? (
          <LoadingRows rows={3} />
        ) : (
          <div className="space-y-4">
            <StatGrid cols={4} data-testid="stock-adjustment-strip">
              <StatTile label="On hand" value={card.onHand} />
              <StatTile label="Reserved" value={card.reserved} />
              <StatTile label="Floor" value={card.floorSample} />
              <StatTile label="Available" value={card.available} />
              <StatTile label="Net on PO" value={card.netOnPo} sub={`of ${card.totalPo} on PO`} />
              <StatTile
                label="As-Is here"
                value={card.asIsOnHand}
                sub={`${card.asIsAvailable} sellable · ${card.asIsNonSellable} not`}
              />
              <StatTile label="Bin" value={card.storageBinCode ?? '—'} />
              <StatTile
                label="Cost"
                value={card.costCents != null ? <Money cents={card.costCents} /> : '—'}
              />
            </StatGrid>

            <div className="seg seg-lg" role="tablist" aria-label="Stock adjustment tabs">
              {visibleTabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  className={`seg-btn${tab === t.key ? ' is-active' : ''}`}
                  onClick={() => setTab(t.key)}
                  data-testid={`stock-tab-${t.key}`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {tab === 'quantity' && (
              <QuantityTab card={card} busy={busy} run={run} requestOverride={setOverride} />
            )}
            {tab === 'bin' && (
              <BinTab card={card} busy={busy} run={run} requestOverride={setOverride} />
            )}
            {tab === 'to_as_is' && (
              <ToAsIsTab card={card} busy={busy} run={run} requestOverride={setOverride} />
            )}
            {tab === 'from_as_is' && (
              <FromAsIsTab card={card} busy={busy} run={run} requestOverride={setOverride} />
            )}
            {tab === 'as_is_status' && (
              <AsIsStatusTab card={card} busy={busy} run={run} requestOverride={setOverride} />
            )}
            {tab === 'as_is_adjust' && (
              <AsIsAdjustTab card={card} busy={busy} run={run} requestOverride={setOverride} />
            )}
            {tab === 'write_off' && (
              <WriteOffTab card={card} busy={busy} run={run} requestOverride={setOverride} />
            )}
            {tab === 'serial' && (
              <SerialTab card={card} busy={busy} run={run} requestOverride={setOverride} />
            )}
            {tab === 'so_info' && <SoInfoTab card={card} onReassign={onReassign} />}
          </div>
        )}
      </ModalDialog>
      <SecurityOverrideDialog
        open={override != null}
        title={override?.title ?? ''}
        usageClass={override?.usageClass ?? null}
        submitLabel={override?.submitLabel ?? 'Confirm'}
        perform={async (payload) => {
          if (override) await override.perform(payload);
        }}
        onClose={() => setOverride(null)}
        onSuccess={() => {
          void load();
          onChanged?.();
        }}
      />
    </>
  );
}

function TabIntro({ children }: { children: ReactNode }) {
  return (
    <p className="muted" style={{ margin: '0 0 8px', fontSize: 12.5 }}>
      {children}
    </p>
  );
}

// ─── Quantity ───────────────────────────────────────────────────────────

function QuantityTab({ card, busy, run }: TabProps) {
  const codes = useReasonCodes('inventory_adjustment');
  const [delta, setDelta] = useState('');
  const [bucket, setBucket] = useState<(typeof ADJUST_BUCKETS)[number]['key']>('count_correction');
  const [reasonCodeId, setReasonCodeId] = useState('');
  const [unitCost, setUnitCost] = useState(
    card.costCents != null ? (card.costCents / 100).toFixed(2) : '',
  );
  const [notes, setNotes] = useState('');
  const d = Number(delta);
  const valid = Number.isInteger(d) && d !== 0 && (codes.length === 0 || reasonCodeId !== '');
  return (
    <form
      data-testid="stock-tab-quantity-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        const costCents = unitCost.trim() ? Math.round(Number(unitCost) * 100) : undefined;
        void run(
          () =>
            api('/v1/inventory/adjust', {
              method: 'POST',
              body: JSON.stringify({
                variantId: card.variantId,
                locationId: card.locationId,
                delta: d,
                reason: bucket,
                ...(reasonCodeId ? { reasonCodeId } : {}),
                ...(d > 0 && costCents != null && Number.isFinite(costCents)
                  ? { unitCostCents: costCents }
                  : {}),
                notes: notes.trim() || undefined,
              }),
            }).then(() => setDelta('')),
          `Adjusted ${d > 0 ? '+' : ''}${d}`,
        );
      }}
    >
      <TabIntro>
        A signed quantity. Positive units layer in at the cost below; negative units consume the
        oldest cost layers. On hand never goes below zero.
      </TabIntro>
      <FormGrid cols={3}>
        <Field label="Quantity (±)" required>
          <Input
            type="number"
            step={1}
            placeholder="e.g. -1 or 3"
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            data-testid="stock-qty-delta"
          />
        </Field>
        <Field label="Type">
          <Select value={bucket} onChange={(e) => setBucket(e.target.value as typeof bucket)}>
            {ADJUST_BUCKETS.map((b) => (
              <option key={b.key} value={b.key}>
                {b.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Reason code"
          required={codes.length > 0}
          hint={
            codes.length === 0 ? 'No inventory-adjustment codes yet — notes stand in' : undefined
          }
        >
          <Select
            value={reasonCodeId}
            onChange={(e) => setReasonCodeId(e.target.value)}
            disabled={codes.length === 0}
            data-testid="stock-qty-reason"
          >
            <option value="">{codes.length ? 'Select a reason…' : '—'}</option>
            {codes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.description}
              </option>
            ))}
          </Select>
        </Field>
        {d > 0 && (
          <Field label="Unit cost" hint="Defaults to the catalog cost">
            <Input
              type="number"
              step="0.01"
              min={0}
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              data-testid="stock-qty-cost"
            />
          </Field>
        )}
        <Field label="Notes" className="form-span">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </FormGrid>
      <FormActions>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !valid}
          data-testid="stock-qty-submit"
        >
          {busy ? 'Working…' : 'Post adjustment'}
        </Button>
      </FormActions>
    </form>
  );
}

// ─── Bin to bin ─────────────────────────────────────────────────────────

function BinTab({ card, busy, run }: TabProps) {
  const [binId, setBinId] = useState(card.storageBinId ?? '');
  return (
    <form
      data-testid="stock-tab-bin-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          () =>
            api('/v1/inventory/levels/assign-bin', {
              method: 'POST',
              body: JSON.stringify({
                variantId: card.variantId,
                locationId: card.locationId,
                storageBinId: binId || null,
              }),
            }),
          binId ? 'Bin updated' : 'Stock unbinned',
        );
      }}
    >
      <TabIntro>
        Where the units physically sit inside {card.locationName}. Bins are managed on the Stock by
        location page.
      </TabIntro>
      <FormGrid cols={2}>
        <Field label="From bin">
          <Input value={card.storageBinCode ?? '—'} readOnly />
        </Field>
        <Field label="To bin" required>
          <Select value={binId} onChange={(e) => setBinId(e.target.value)} data-testid="stock-bin">
            <option value="">— No bin —</option>
            {card.bins.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code}
              </option>
            ))}
          </Select>
        </Field>
      </FormGrid>
      <FormActions>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || card.onHand === 0 || binId === (card.storageBinId ?? '')}
        >
          {busy ? 'Working…' : 'Move'}
        </Button>
      </FormActions>
    </form>
  );
}

// ─── Move to As-Is ──────────────────────────────────────────────────────

function ToAsIsTab({ card, busy, requestOverride }: TabProps) {
  const [quantity, setQuantity] = useState('1');
  const [condition, setCondition] = useState<string>('light_wear');
  const [storage, setStorage] = useState('');
  const [notes, setNotes] = useState('');
  const q = Number(quantity);
  const valid = Number.isInteger(q) && q > 0 && q <= card.available;
  return (
    <form
      data-testid="stock-tab-to-as-is-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        requestOverride({
          title: `Move ${q} unit(s) to As-Is`,
          usageClass: 'as_is',
          submitLabel: 'Move to As-Is',
          perform: async (payload) => {
            await api('/v1/as-is', {
              method: 'POST',
              body: JSON.stringify({
                variantId: card.variantId,
                locationId: card.locationId,
                quantity: q,
                source: 'stock',
                fromStock: true,
                condition,
                storageLocation: storage.trim() || null,
                notes: notes.trim() || null,
                reasonCodeId: payload.reasonCodeId,
                reason: payload.reason,
                override: payload.override,
              }),
            });
            toast.success(`${q} unit(s) moved to As-Is`);
          },
        });
      }}
    >
      <TabIntro>
        Takes sellable units out of stock and into the As-Is queue as individual pieces (one row
        each). Only available units can move — release reservations or the floor hold first.
      </TabIntro>
      <FormGrid cols={3}>
        <Field label="Units" hint={`${card.available} available`} required>
          <Input
            type="number"
            min={1}
            max={card.available}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            data-testid="stock-to-as-is-qty"
          />
        </Field>
        <Field label="Condition">
          <Select value={condition} onChange={(e) => setCondition(e.target.value)}>
            {CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {c.replace('_', ' ')}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Storage location" hint="Where the piece sits (rack, bay)">
          <Input value={storage} onChange={(e) => setStorage(e.target.value)} />
        </Field>
        <Field label="Notes" className="form-span">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </FormGrid>
      <FormActions>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !valid}
          data-testid="stock-to-as-is-submit"
        >
          Continue — reason
        </Button>
      </FormActions>
    </form>
  );
}

// ─── Move from As-Is ────────────────────────────────────────────────────

function FromAsIsTab({ card, busy, run }: TabProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<'same' | 'as_is_variant'>('same');
  const [notes, setNotes] = useState('');
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <form
      data-testid="stock-tab-from-as-is-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (selected.size === 0) return;
        const ids = [...selected];
        void run(async () => {
          for (const id of ids) {
            await api(`/v1/as-is/${id}/review`, {
              method: 'POST',
              body: JSON.stringify({
                action: 'restock',
                ...(target === 'as_is_variant' && card.asIsVariantId
                  ? { targetVariantId: card.asIsVariantId }
                  : {}),
                notes: notes.trim() || null,
              }),
            });
          }
          setSelected(new Set());
        }, `${ids.length} piece(s) restocked`);
      }}
    >
      <TabIntro>
        Puts pending As-Is pieces back into sellable stock — this product, or its <code>-AS</code>{' '}
        variant when the catalog carries one.
      </TabIntro>
      {card.asIsPieces.length === 0 ? (
        <Alert tone="info">No As-Is pieces are waiting here.</Alert>
      ) : (
        <TableWrap>
          <table className="table">
            <thead>
              <tr>
                <th />
                <th>Piece</th>
                <th>Condition</th>
                <th>Storage</th>
                <th>Source</th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {card.asIsPieces.map((p) => (
                <tr key={p.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggle(p.id)}
                      aria-label={`Select ${p.pieceNumber ?? p.id}`}
                      data-testid="stock-from-as-is-pick"
                    />
                  </td>
                  <td>
                    <code>{p.pieceNumber ?? p.id.slice(0, 8)}</code>
                  </td>
                  <td>{p.condition ?? '—'}</td>
                  <td>{p.storageLocation ?? '—'}</td>
                  <td>{p.source}</td>
                  <td>{fmtDay(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <FormGrid cols={2}>
        <Field label="Restock as">
          <Select value={target} onChange={(e) => setTarget(e.target.value as typeof target)}>
            <option value="same">This product (sellable as new)</option>
            {card.asIsVariantId && <option value="as_is_variant">As-Is variant (-AS)</option>}
          </Select>
        </Field>
        <Field label="Notes">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </FormGrid>
      <FormActions>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || selected.size === 0}
          data-testid="stock-from-as-is-submit"
        >
          {busy ? 'Working…' : `Restock ${selected.size || ''}`.trim()}
        </Button>
      </FormActions>
    </form>
  );
}

// ─── As-Is status ───────────────────────────────────────────────────────

function AsIsStatusTab({ card, busy, run, requestOverride }: TabProps) {
  const [pieceId, setPieceId] = useState(card.asIsPieces[0]?.id ?? '');
  const piece = card.asIsPieces.find((p) => p.id === pieceId);
  const [condition, setCondition] = useState(piece?.condition ?? '');
  const [storage, setStorage] = useState(piece?.storageLocation ?? '');
  const [price, setPrice] = useState(
    piece?.asIsPriceCents != null ? (piece.asIsPriceCents / 100).toFixed(2) : '',
  );
  useEffect(() => {
    setCondition(piece?.condition ?? '');
    setStorage(piece?.storageLocation ?? '');
    setPrice(piece?.asIsPriceCents != null ? (piece.asIsPriceCents / 100).toFixed(2) : '');
  }, [piece]);

  function patchBody(override?: OverridePayload['override']) {
    const priceCents = price.trim() ? Math.round(Number(price) * 100) : null;
    const body: Record<string, unknown> = {
      condition: condition || null,
      storageLocation: storage.trim() || null,
    };
    if (priceCents !== (piece?.asIsPriceCents ?? null)) body.asIsPriceCents = priceCents;
    if (override) body.override = override;
    return body;
  }

  return (
    <form
      data-testid="stock-tab-as-is-status-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!piece) return;
        void run(async () => {
          try {
            await api(`/v1/as-is/${piece.id}`, {
              method: 'PATCH',
              body: JSON.stringify(patchBody()),
            });
          } catch (err) {
            if (err instanceof ApiError && err.code === 'OVERRIDE_REQUIRED') {
              requestOverride({
                title: `Set the As-Is price on ${piece.pieceNumber ?? 'this piece'}`,
                usageClass: null,
                submitLabel: 'Approve price',
                perform: async (payload) => {
                  await api(`/v1/as-is/${piece.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify(patchBody(payload.override)),
                  });
                },
              });
              return;
            }
            throw err;
          }
        }, 'Piece updated');
      }}
    >
      <TabIntro>
        Condition, storage location and the As-Is selling price of one pending piece. Setting a
        price needs the as-is pricing permission (or a manager approval).
      </TabIntro>
      {card.asIsPieces.length === 0 ? (
        <Alert tone="info">No As-Is pieces are waiting here.</Alert>
      ) : (
        <FormGrid cols={2}>
          <Field label="Piece" required className="form-span">
            <Select
              value={pieceId}
              onChange={(e) => setPieceId(e.target.value)}
              data-testid="stock-as-is-piece"
            >
              {card.asIsPieces.map((p) => (
                <option key={p.id} value={p.id}>
                  {pieceLabel(p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Condition">
            <Select value={condition} onChange={(e) => setCondition(e.target.value)}>
              <option value="">—</option>
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {c.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Storage location">
            <Input value={storage} onChange={(e) => setStorage(e.target.value)} />
          </Field>
          <Field label="As-Is price" hint="Blank clears the price">
            <Input
              type="number"
              step="0.01"
              min={0}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              data-testid="stock-as-is-price"
            />
          </Field>
        </FormGrid>
      )}
      <FormActions>
        <Button type="submit" variant="primary" disabled={busy || !piece}>
          {busy ? 'Working…' : 'Save'}
        </Button>
      </FormActions>
    </form>
  );
}

// ─── As-Is adjustment ───────────────────────────────────────────────────

function AsIsAdjustTab({ card, busy, run }: TabProps) {
  const [mode, setMode] = useState<'remove' | 'add'>('remove');
  const [pieceId, setPieceId] = useState(card.asIsPieces[0]?.id ?? '');
  const piece = card.asIsPieces.find((p) => p.id === pieceId);
  const [returnToStock, setReturnToStock] = useState(false);
  const [reason, setReason] = useState('');
  const [addQty, setAddQty] = useState('1');
  const [addCondition, setAddCondition] = useState('light_wear');
  useEffect(() => setReturnToStock(piece?.source === 'stock'), [piece]);
  const addN = Number(addQty);
  const valid =
    mode === 'remove'
      ? piece != null && reason.trim().length > 0
      : Number.isInteger(addN) && addN > 0 && reason.trim().length > 0;
  return (
    <form
      data-testid="stock-tab-as-is-adjust-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        if (mode === 'remove' && piece) {
          void run(
            () =>
              api(`/v1/as-is/${piece.id}/void`, {
                method: 'POST',
                body: JSON.stringify({ reason: reason.trim(), returnToStock }),
              }).then(() => setReason('')),
            returnToStock ? 'Piece voided and returned to stock' : 'Piece voided',
          );
        } else {
          void run(
            () =>
              api('/v1/as-is', {
                method: 'POST',
                body: JSON.stringify({
                  variantId: card.variantId,
                  locationId: card.locationId,
                  quantity: addN,
                  source: 'warranty',
                  condition: addCondition,
                  reason: reason.trim(),
                  notes: reason.trim(),
                }),
              }).then(() => setReason('')),
            `${addN} piece(s) added to As-Is`,
          );
        }
      }}
    >
      <TabIntro>
        Correct the As-Is count without a disposition: void a piece that was taken in by mistake
        (optionally putting the unit back into sellable stock), or add pieces found on the floor
        that never came out of stock.
      </TabIntro>
      <div className="seg" role="tablist" style={{ marginBottom: 10 }}>
        <button
          type="button"
          className={`seg-btn${mode === 'remove' ? ' is-active' : ''}`}
          onClick={() => setMode('remove')}
        >
          Remove a piece
        </button>
        <button
          type="button"
          className={`seg-btn${mode === 'add' ? ' is-active' : ''}`}
          onClick={() => setMode('add')}
        >
          Add pieces
        </button>
      </div>
      {mode === 'remove' ? (
        card.asIsPieces.length === 0 ? (
          <Alert tone="info">No As-Is pieces are waiting here.</Alert>
        ) : (
          <FormGrid cols={2}>
            <Field label="Piece" required className="form-span">
              <Select
                value={pieceId}
                onChange={(e) => setPieceId(e.target.value)}
                data-testid="stock-as-is-void-piece"
              >
                {card.asIsPieces.map((p) => (
                  <option key={p.id} value={p.id}>
                    {pieceLabel(p)} · from {p.source}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reason" required>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                data-testid="stock-as-is-void-reason"
              />
            </Field>
            <Field label="Stock" as="div">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={returnToStock}
                  onChange={(e) => setReturnToStock(e.target.checked)}
                  data-testid="stock-as-is-void-return"
                />
                Return the unit to sellable stock
              </label>
            </Field>
          </FormGrid>
        )
      ) : (
        <FormGrid cols={3}>
          <Field label="Pieces" required>
            <Input
              type="number"
              min={1}
              value={addQty}
              onChange={(e) => setAddQty(e.target.value)}
            />
          </Field>
          <Field label="Condition">
            <Select value={addCondition} onChange={(e) => setAddCondition(e.target.value)}>
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {c.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reason" required>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </FormGrid>
      )}
      <FormActions>
        <Button
          type="submit"
          variant={mode === 'remove' ? 'danger' : 'primary'}
          disabled={busy || !valid}
          data-testid="stock-as-is-adjust-submit"
        >
          {busy ? 'Working…' : mode === 'remove' ? 'Void piece' : 'Add pieces'}
        </Button>
      </FormActions>
    </form>
  );
}

// ─── Write-off ──────────────────────────────────────────────────────────

function WriteOffTab({ card, busy, requestOverride }: TabProps) {
  const [quantity, setQuantity] = useState('1');
  const [notes, setNotes] = useState('');
  const q = Number(quantity);
  const valid = Number.isInteger(q) && q > 0 && q <= card.available;
  const cost = card.costCents != null ? card.costCents * (valid ? q : 0) : null;
  return (
    <form
      data-testid="stock-tab-write-off-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        requestOverride({
          title: `Write off ${q} unit(s) of ${card.sku ?? card.productName}`,
          usageClass: 'write_off',
          submitLabel: 'Write off',
          perform: async (payload) => {
            await api('/v1/inventory/write-off', {
              method: 'POST',
              body: JSON.stringify({
                variantId: card.variantId,
                locationId: card.locationId,
                quantity: q,
                notes: notes.trim() || undefined,
                reasonCodeId: payload.reasonCodeId,
                reason: payload.reason,
                override: payload.override,
              }),
            });
            toast.success(`${q} unit(s) written off`);
          },
        });
      }}
    >
      <TabIntro>
        Scraps units straight out of sellable stock: valued at cost on the write-off register,
        flagged on the exceptions feed, and gated by the write-off permission (a manager can approve
        it here).
      </TabIntro>
      <FormGrid cols={3}>
        <Field label="Units" hint={`${card.available} available`} required>
          <Input
            type="number"
            min={1}
            max={card.available}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            data-testid="stock-write-off-qty"
          />
        </Field>
        <Field label="Cost to write off">
          <Input value={cost != null ? `$${(cost / 100).toFixed(2)}` : '—'} readOnly />
        </Field>
        <Field label="Notes">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </FormGrid>
      <FormActions>
        <Button
          type="submit"
          variant="danger"
          disabled={busy || !valid}
          data-testid="stock-write-off-submit"
        >
          Continue — reason &amp; approval
        </Button>
      </FormActions>
    </form>
  );
}

// ─── Change serial ──────────────────────────────────────────────────────

function SerialTab({ card, busy, run }: TabProps) {
  const [serialId, setSerialId] = useState(card.serials[0]?.id ?? '');
  const [serial, setSerial] = useState('');
  const unit = card.serials.find((s) => s.id === serialId);
  const valid = unit != null && serial.trim().length > 0 && serial.trim() !== unit.serial;
  return (
    <form
      data-testid="stock-tab-serial-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || !unit) return;
        void run(
          () =>
            api(`/v1/serials/${unit.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ serial: serial.trim() }),
            }).then(() => setSerial('')),
          `Serial ${unit.serial} is now ${serial.trim()}`,
        );
      }}
    >
      <TabIntro>
        Correct a mistyped serial on a unit that is still in the building. Sold and in-service units
        keep the serial on the customer&apos;s paperwork.
      </TabIntro>
      {card.serials.length === 0 ? (
        <Alert tone="info">No serial units are registered here.</Alert>
      ) : (
        <FormGrid cols={2}>
          <Field label="Serial" required>
            <Select
              value={serialId}
              onChange={(e) => setSerialId(e.target.value)}
              data-testid="stock-serial-pick"
            >
              {card.serials.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.serial} · {s.status.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="New serial" required>
            <Input
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
              data-testid="stock-serial-new"
            />
          </Field>
        </FormGrid>
      )}
      <FormActions>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !valid}
          data-testid="stock-serial-submit"
        >
          {busy ? 'Working…' : 'Change serial'}
        </Button>
      </FormActions>
    </form>
  );
}

// ─── SO info ────────────────────────────────────────────────────────────

function SoInfoTab({ card, onReassign }: { card: StockCard; onReassign?: () => void }) {
  const [board, setBoard] = useState<ReservationBoard | null>(null);
  useEffect(() => {
    api<ReservationBoard>(
      `/v1/inventory/reservation-board?variantId=${card.variantId}&locationId=${card.locationId}`,
    )
      .then(setBoard)
      .catch(() =>
        setBoard({ strip: { onHand: 0, reserved: 0, floorSample: 0, available: 0 }, rows: [] }),
      );
  }, [card.variantId, card.locationId]);
  return (
    <div data-testid="stock-tab-so-info">
      <TabIntro>
        The open sales-order lines that want this item here — who is waiting, by when, and how many
        units each already holds.
      </TabIntro>
      {!board ? (
        <LoadingRows rows={2} />
      ) : (
        <TableWrap>
          <table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Kind</th>
                <th>Fill by</th>
                <th className="num">Qty</th>
                <th className="num">Reserved</th>
                <th className="num">Short</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {board.rows.length === 0 && (
                <TableEmpty colSpan={8}>No open order line wants this item here.</TableEmpty>
              )}
              {board.rows.map((r) => (
                <tr key={r.lineId}>
                  <td>
                    <Link href={`/orders/${r.orderId}`}>{r.orderNumber}</Link>
                  </td>
                  <td>{r.customerName ?? '—'}</td>
                  <td>
                    {r.orderKind}
                    {r.fulfillmentType ? ` · ${r.fulfillmentType}` : ''}
                  </td>
                  <td>{fmtDay(r.fillBy)}</td>
                  <td className="num">{r.quantity}</td>
                  <td className="num">{r.qtyReserved}</td>
                  <td className="num">{r.shortfall}</td>
                  <td>
                    <StatusBadge status={r.orderStatus} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {onReassign && (
        <FormActions>
          <Button variant="secondary" onClick={onReassign} data-testid="stock-so-reassign">
            Reassign reservation…
          </Button>
        </FormActions>
      )}
    </div>
  );
}
