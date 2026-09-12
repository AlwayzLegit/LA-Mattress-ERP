'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { ProductsNav } from '@/components/products-nav';
import { Alert, Button, Field, Input, Select } from '@/components/ui';

/**
 * Receive (redesign Phase 7, README §3.3, canvas 6d). Against a PO when
 * there is one: pick the PO, where it lands, the packing slip, blind
 * count if the policy asks; per line Ordered · Already in · Received now
 * · Damaged · Bin · Still open, with the sales orders waiting on it. The
 * rail is the confirmation: units received, damaged → As-Is (with a
 * reason), still open on the PO, and the **orders unblocked** by the
 * post. Short lines stay open on the PO. Receiving without a PO is the
 * secondary path and needs a reason.
 */

interface PoListRow {
  id: string;
  number: string;
  status: string;
  vendorName: string | null;
  locationId: string;
  expectedAt: string | null;
}
interface PoLine {
  id: string;
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  quantityOrdered: number;
  quantityReceived: number;
  quantityAccepted: number;
  quantityRejected: number;
  linkedOrders: { orderId: string; orderNumber: string; quantity: number }[];
}
interface PoDetail extends PoListRow {
  blindReceiving: boolean;
  locationName: string | null;
  lines: PoLine[];
}
interface PoReceiveResult extends PoDetail {
  unblockedOrders: { orderId: string; number: string; units: number }[];
}
interface LocationRow {
  id: string;
  name: string;
  locationType?: string;
}
interface BinRow {
  id: string;
  code: string;
  locationId: string;
}
interface ReasonCode {
  id: string;
  code: string;
  description: string;
}
interface SearchHit {
  id: string;
  name: string;
  sku: string | null;
  variants?: { id: string; sku: string | null; name: string | null }[];
}

const DAMAGE_REASONS = [
  { value: 'DMG', label: 'DMG — Damaged in transit' },
  { value: 'MFG', label: 'MFG — Manufacturing defect' },
  { value: 'PKG', label: 'PKG — Packaging only' },
];

function fmtDay(v: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function dueWord(v: string | null): string {
  if (!v) return '';
  const today = new Date().toISOString().slice(0, 10);
  const day = v.slice(0, 10);
  if (day === today) return 'due today';
  return day < today ? `overdue ${fmtDay(v)}` : `due ${fmtDay(v)}`;
}

export default function ReceivePage() {
  const [mode, setMode] = useState<'po' | 'adhoc'>('po');
  const [pos, setPos] = useState<PoListRow[] | null>(null);
  const [poId, setPoId] = useState('');
  const [po, setPo] = useState<PoDetail | null>(null);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [into, setInto] = useState('');
  const [bins, setBins] = useState<BinRow[]>([]);
  const [slip, setSlip] = useState('');
  const [blind, setBlind] = useState(false);
  const [now, setNow] = useState<Record<string, string>>({});
  const [dmg, setDmg] = useState<Record<string, string>>({});
  const [bin, setBin] = useState<Record<string, string>>({});
  const [dmgReason, setDmgReason] = useState('DMG');
  const [dmgNote, setDmgNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<PoReceiveResult | null>(null);
  // Receive without a PO (secondary).
  const [adhocQ, setAdhocQ] = useState('');
  const [adhocHits, setAdhocHits] = useState<SearchHit[]>([]);
  const [adhocLines, setAdhocLines] = useState<{ variantId: string; label: string; qty: string }[]>(
    [],
  );
  const [adhocReason, setAdhocReason] = useState('');
  const [adhocDone, setAdhocDone] = useState<string | null>(null);

  useEffect(() => {
    void api<{ data: PoListRow[] }>('/v1/purchase-orders?status=ordered&limit=100')
      .then(async (a) => {
        const b = await api<{ data: PoListRow[] }>(
          '/v1/purchase-orders?status=partially_received&limit=100',
        ).catch(() => ({ data: [] as PoListRow[] }));
        const all = [...a.data, ...b.data].sort((x, y) =>
          (x.expectedAt ?? '9999').localeCompare(y.expectedAt ?? '9999'),
        );
        setPos(all);
        const first = new URLSearchParams(window.location.search).get('po') ?? all[0]?.id ?? '';
        setPoId(first);
      })
      .catch((e) => {
        setPos([]);
        setError(e instanceof Error ? e.message : String(e));
      });
    void api<LocationRow[]>('/v1/business/locations')
      .then(setLocations)
      .catch(() => setLocations([]));
  }, []);

  useEffect(() => {
    if (!poId) {
      setPo(null);
      return;
    }
    setDone(null);
    void api<PoDetail>(`/v1/purchase-orders/${poId}`)
      .then((d) => {
        setPo(d);
        setInto(d.locationId);
        setBlind(!!d.blindReceiving);
        setNow({});
        setDmg({});
        setBin({});
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [poId]);

  useEffect(() => {
    if (!into) return;
    void api<BinRow[]>(`/v1/inventory/bins?locationId=${into}`)
      .then(setBins)
      .catch(() => setBins([]));
  }, [into]);

  useEffect(() => {
    if (mode !== 'adhoc' || !adhocQ.trim()) {
      setAdhocHits([]);
      return;
    }
    const t = setTimeout(() => {
      void api<{ data: SearchHit[] }>(
        `/v1/products?q=${encodeURIComponent(adhocQ.trim())}&limit=20`,
      )
        .then((r) => setAdhocHits(r.data))
        .catch(() => setAdhocHits([]));
    }, 220);
    return () => clearTimeout(t);
  }, [adhocQ, mode]);

  const lines = po?.lines ?? [];
  const num = (m: Record<string, string>, id: string) => {
    const n = Math.trunc(Number(m[id] ?? ''));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const totals = useMemo(() => {
    let received = 0;
    let damaged = 0;
    let stillOpen = 0;
    const waiting = new Map<string, { orderId: string; number: string }>();
    for (const l of lines) {
      const open = l.quantityOrdered - l.quantityAccepted - l.quantityRejected;
      const r = num(now, l.id);
      const d = num(dmg, l.id);
      received += r;
      damaged += d;
      stillOpen += Math.max(0, open - r - d);
      if (r > 0)
        for (const o of l.linkedOrders)
          waiting.set(o.orderId, { orderId: o.orderId, number: o.orderNumber });
    }
    return { received, damaged, stillOpen, unblocked: [...waiting.values()] };
  }, [lines, now, dmg]);
  const overs = lines.filter(
    (l) =>
      num(now, l.id) + num(dmg, l.id) > l.quantityOrdered - l.quantityAccepted - l.quantityRejected,
  );
  const canPost =
    !!po &&
    !busy &&
    totals.received + totals.damaged > 0 &&
    overs.length === 0 &&
    (totals.damaged === 0 || (!!dmgReason && dmgNote.trim().length > 0));

  async function post() {
    if (!po || !canPost) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        notes:
          [
            slip.trim() ? `Packing slip ${slip.trim()}` : '',
            totals.damaged > 0
              ? `Damaged: ${dmgReason}${dmgNote.trim() ? ` — ${dmgNote.trim()}` : ''}`
              : '',
          ]
            .filter(Boolean)
            .join(' · ') || undefined,
        lines: lines
          .map((l) => {
            const r = num(now, l.id);
            const d = num(dmg, l.id);
            return { lineId: l.id, received: r + d, inspected: r + d, accepted: r, rejected: d };
          })
          .filter((l) => l.received > 0),
      };
      const res = await api<PoReceiveResult>(`/v1/purchase-orders/${po.id}/receiving`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      // Bins: assign after the units exist at the location.
      for (const l of lines) {
        const b = bin[l.id];
        if (b && num(now, l.id) > 0) {
          await api('/v1/inventory/levels/assign-bin', {
            method: 'POST',
            body: JSON.stringify({
              variantId: l.variantId,
              locationId: into || po.locationId,
              storageBinId: b,
            }),
          }).catch(() => undefined);
        }
      }
      setDone(res);
      setPo(res);
      setNow({});
      setDmg({});
      toast.success(
        `${po.number}: ${totals.received} received${totals.damaged ? `, ${totals.damaged} to As-Is` : ''}${
          res.unblockedOrders.length
            ? ` · ${res.unblockedOrders.length} order${res.unblockedOrders.length === 1 ? '' : 's'} unblocked`
            : ''
        }`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function postAdhoc() {
    const valid = adhocLines.filter((l) => Number(l.qty) > 0);
    if (!into || valid.length === 0 || !adhocReason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api('/v1/inventory/receive', {
        method: 'POST',
        body: JSON.stringify({
          locationId: into,
          notes: `Received without PO: ${adhocReason.trim()}${slip.trim() ? ` · slip ${slip.trim()}` : ''}`,
          lines: valid.map((l) => ({
            variantId: l.variantId,
            quantity: Math.trunc(Number(l.qty)),
          })),
        }),
      });
      setAdhocDone(
        `${valid.reduce((n, l) => n + Math.trunc(Number(l.qty)), 0)} units received into ${locations.find((x) => x.id === into)?.name ?? 'stock'}.`,
      );
      setAdhocLines([]);
      setAdhocReason('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const intoName = locations.find((l) => l.id === into)?.name ?? po?.locationName ?? '';

  return (
    <div className="rcv" data-testid="receive-page">
      <header className="pb-head">
        <div>
          <div className="pp-crumb">
            <Link href="/products">Products</Link> / Receive
          </div>
          <h1 className="pb-title">Receive</h1>
          <div className="pb-sub">
            Against a PO when there is one. Short lines stay open on the PO; damaged units go to
            As-Is with a reason.
          </div>
        </div>
        <div className="pb-head-actions">
          <Button
            size="sm"
            onClick={() => setMode(mode === 'po' ? 'adhoc' : 'po')}
            data-testid="receive-mode"
          >
            {mode === 'po' ? 'Receive without PO' : 'Receive against a PO'}
          </Button>
        </div>
      </header>
      <ProductsNav />

      {error && <Alert tone="error">{error}</Alert>}

      {mode === 'po' ? (
        <div className="rcv-grid">
          <section className="rcv-card" aria-label="Purchase order">
            <div className="rcv-form">
              <Field label="Purchase order">
                <Select
                  value={poId}
                  onChange={(e) => setPoId(e.target.value)}
                  data-testid="receive-po"
                >
                  {pos === null && <option value="">Loading…</option>}
                  {pos && pos.length === 0 && <option value="">No open purchase orders</option>}
                  {pos?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.number} · {p.vendorName ?? 'vendor'}
                      {p.status === 'partially_received' ? ' · partly received' : ''}
                      {p.expectedAt ? ` · ${dueWord(p.expectedAt)}` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Into" hint="Set by the purchase order">
                <Input
                  value={po?.locationName ?? locations.find((l) => l.id === into)?.name ?? ''}
                  readOnly
                  data-testid="receive-into"
                />
              </Field>
              <Field label="Packing slip #">
                <Input
                  value={slip}
                  onChange={(e) => setSlip(e.target.value)}
                  className="input-mono"
                  data-testid="receive-slip"
                />
              </Field>
              <label className="pb-check" style={{ height: 38 }}>
                <input
                  type="checkbox"
                  checked={blind}
                  onChange={(e) => setBlind(e.target.checked)}
                  data-testid="receive-blind"
                />
                Blind count (hide expected)
              </label>
            </div>
            <table className="table rcv-table" data-testid="receive-lines">
              <thead>
                <tr>
                  <th>Line</th>
                  {!blind && <th className="num">Ordered</th>}
                  {!blind && <th className="num">Already in</th>}
                  <th className="num">Received now</th>
                  <th className="num">Damaged</th>
                  <th>Bin</th>
                  {!blind && <th className="num">Still open</th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const open = l.quantityOrdered - l.quantityAccepted - l.quantityRejected;
                  const r = num(now, l.id);
                  const d = num(dmg, l.id);
                  const still = open - r - d;
                  const over = still < 0;
                  return (
                    <tr key={l.id} data-testid="receive-line">
                      <td>
                        <div className="rcv-line-name">
                          {l.productName}
                          {l.variantName ? ` — ${l.variantName}` : ''}
                        </div>
                        <div className="rcv-line-sub">
                          {l.sku ?? '—'}
                          {l.linkedOrders.length > 0 && (
                            <>
                              {' · '}
                              <span className="rcv-waiting">
                                waiting: {l.linkedOrders.map((o) => o.orderNumber).join(', ')}
                              </span>
                            </>
                          )}
                        </div>
                      </td>
                      {!blind && <td className="num pp-num">{l.quantityOrdered}</td>}
                      {!blind && (
                        <td className="num pp-num">{l.quantityAccepted + l.quantityRejected}</td>
                      )}
                      <td className="num">
                        <Input
                          type="number"
                          min={0}
                          value={now[l.id] ?? ''}
                          onChange={(e) => setNow((m) => ({ ...m, [l.id]: e.target.value }))}
                          className="rcv-qty"
                          aria-label={`Received now for ${l.productName}`}
                          data-testid="receive-now"
                        />
                      </td>
                      <td className="num">
                        <Input
                          type="number"
                          min={0}
                          value={dmg[l.id] ?? ''}
                          onChange={(e) => setDmg((m) => ({ ...m, [l.id]: e.target.value }))}
                          className="rcv-qty"
                          aria-label={`Damaged for ${l.productName}`}
                          data-testid="receive-damaged"
                        />
                      </td>
                      <td>
                        <Select
                          value={bin[l.id] ?? ''}
                          onChange={(e) => setBin((m) => ({ ...m, [l.id]: e.target.value }))}
                          aria-label={`Bin for ${l.productName}`}
                        >
                          <option value="">—</option>
                          {bins.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.code}
                            </option>
                          ))}
                        </Select>
                      </td>
                      {!blind && (
                        <td
                          className={`num pp-num${over ? ' is-risk' : still === 0 && r + d > 0 ? ' is-ok' : still > 0 && r + d > 0 ? ' is-waiting' : ''}`}
                        >
                          {over ? `over by ${-still}` : still}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {po && lines.length === 0 && (
                  <tr>
                    <td colSpan={7} className="pb-empty">
                      Nothing left to receive on {po.number}.
                    </td>
                  </tr>
                )}
                {!po && (
                  <tr>
                    <td colSpan={7} className="pb-empty">
                      {pos && pos.length === 0
                        ? 'No open purchase orders. Use Receive without PO for a walk-in delivery.'
                        : 'Pick a purchase order.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          <aside className="rcv-card rcv-rail" aria-label="This receipt" data-testid="receive-rail">
            <h2>This receipt</h2>
            <div className={`rcv-stat${totals.received > 0 ? ' is-good' : ''}`}>
              <span>Units received</span>
              <strong data-testid="rail-received">{totals.received}</strong>
            </div>
            <div className={`rcv-stat${totals.damaged > 0 ? ' is-warn' : ''}`}>
              <span>Damaged → As-Is</span>
              <strong data-testid="rail-damaged">{totals.damaged}</strong>
            </div>
            <div className="rcv-stat">
              <span>Still open on PO</span>
              <strong data-testid="rail-open">{totals.stillOpen}</strong>
            </div>
            <div className={`rcv-stat${totals.unblocked.length > 0 ? ' is-good' : ''}`}>
              <span>Orders unblocked</span>
              <strong data-testid="rail-unblocked">
                {done ? done.unblockedOrders.length : totals.unblocked.length}
              </strong>
            </div>
            {(done ? done.unblockedOrders : totals.unblocked).length > 0 && (
              <div className="rcv-hint" style={{ textAlign: 'left' }}>
                {(done ? done.unblockedOrders : totals.unblocked).map((o) => (
                  <Link key={o.orderId} href={`/orders/${o.orderId}`} style={{ marginRight: 8 }}>
                    {o.number}
                  </Link>
                ))}
              </div>
            )}
            {totals.damaged > 0 && (
              <div className="rcv-damage" data-testid="receive-damage-block">
                <Field label="Damage reason" required>
                  <Select
                    value={dmgReason}
                    onChange={(e) => setDmgReason(e.target.value)}
                    data-testid="receive-damage-reason"
                  >
                    {DAMAGE_REASONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Note" required>
                  <Input
                    value={dmgNote}
                    onChange={(e) => setDmgNote(e.target.value)}
                    placeholder="Where the damage is"
                    required
                    data-testid="receive-damage-note"
                  />
                </Field>
              </div>
            )}
            {overs.length > 0 && (
              <Alert tone="error">
                {overs.length === 1 ? 'One line' : `${overs.length} lines`} receive more than is
                still open. Short is fine; over is not.
              </Alert>
            )}
            <Button
              variant="primary"
              onClick={() => void post()}
              disabled={!canPost}
              data-testid="post-receipt"
              style={{ height: 40 }}
            >
              {busy ? 'Posting…' : 'Post receipt'}
            </Button>
            <div className="rcv-hint">
              {!po
                ? 'Pick a purchase order.'
                : totals.received + totals.damaged === 0
                  ? 'Enter what arrived. Lines you leave blank stay open on the PO.'
                  : `${totals.received} into ${intoName}${totals.damaged ? ` · ${totals.damaged} to As-Is` : ''}${totals.stillOpen ? ` · ${totals.stillOpen} stay open` : ' · PO complete'}`}
            </div>
            {done && (
              <div className="rcv-done" data-testid="receive-success">
                Posted.{' '}
                {done.status === 'received'
                  ? `${done.number} is fully received.`
                  : `${done.number} stays open for the rest.`}
                {done.unblockedOrders.length > 0 &&
                  ` ${done.unblockedOrders.length} order${done.unblockedOrders.length === 1 ? '' : 's'} moved to Reserved.`}
              </div>
            )}
          </aside>
        </div>
      ) : (
        <div className="rcv-grid">
          <section className="rcv-card" aria-label="Receive without PO">
            <div
              className="rcv-form"
              style={{
                gridTemplateColumns: 'minmax(220px, 2fr) minmax(160px, 1fr) minmax(140px, 1fr)',
              }}
            >
              <Field label="Find a product">
                <Input
                  value={adhocQ}
                  onChange={(e) => setAdhocQ(e.target.value)}
                  placeholder="Name, SKU or barcode"
                  data-testid="adhoc-search"
                />
              </Field>
              <Field label="Into">
                <Select
                  value={into}
                  onChange={(e) => setInto(e.target.value)}
                  data-testid="adhoc-into"
                >
                  <option value="">Choose…</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Packing slip #">
                <Input
                  value={slip}
                  onChange={(e) => setSlip(e.target.value)}
                  className="input-mono"
                />
              </Field>
            </div>
            {adhocHits.length > 0 && (
              <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)' }}>
                {adhocHits.slice(0, 8).map((h) => (
                  <Button
                    key={h.id}
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const d = await api<{
                        variants: { id: string; sku: string | null; name: string | null }[];
                      }>(`/v1/products/${h.id}`);
                      setAdhocLines((prev) => [
                        ...prev,
                        ...d.variants
                          .filter((v) => !prev.some((p) => p.variantId === v.id))
                          .map((v) => ({
                            variantId: v.id,
                            label: `${h.name}${v.name ? ` — ${v.name}` : ''} (${v.sku ?? '—'})`,
                            qty: '',
                          })),
                      ]);
                      setAdhocQ('');
                    }}
                  >
                    + {h.name} <span className="pb-mono">{h.sku ?? ''}</span>
                  </Button>
                ))}
              </div>
            )}
            <table className="table rcv-table">
              <thead>
                <tr>
                  <th>Line</th>
                  <th className="num">Quantity</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {adhocLines.map((l) => (
                  <tr key={l.variantId}>
                    <td className="rcv-line-name">{l.label}</td>
                    <td className="num">
                      <Input
                        type="number"
                        min={0}
                        value={l.qty}
                        onChange={(e) =>
                          setAdhocLines((prev) =>
                            prev.map((x) =>
                              x.variantId === l.variantId ? { ...x, qty: e.target.value } : x,
                            ),
                          )
                        }
                        className="rcv-qty"
                        aria-label={`Quantity for ${l.label}`}
                      />
                    </td>
                    <td className="num">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setAdhocLines((prev) => prev.filter((x) => x.variantId !== l.variantId))
                        }
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
                {adhocLines.length === 0 && (
                  <tr>
                    <td colSpan={3} className="pb-empty">
                      Find a product above to add its variants.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
          <aside className="rcv-card rcv-rail" aria-label="This receipt">
            <h2>Without a PO</h2>
            <div className="rcv-stat">
              <span>Units</span>
              <strong>
                {adhocLines.reduce(
                  (n, l) => n + (Number(l.qty) > 0 ? Math.trunc(Number(l.qty)) : 0),
                  0,
                )}
              </strong>
            </div>
            <Field label="Why there is no PO" required>
              <Input
                value={adhocReason}
                onChange={(e) => setAdhocReason(e.target.value)}
                placeholder="e.g. vendor sent replacements"
                data-testid="adhoc-reason"
              />
            </Field>
            <Button
              variant="primary"
              onClick={() => void postAdhoc()}
              disabled={
                busy || !into || !adhocReason.trim() || !adhocLines.some((l) => Number(l.qty) > 0)
              }
              data-testid="adhoc-post"
              style={{ height: 40 }}
            >
              {busy ? 'Posting…' : 'Post receipt'}
            </Button>
            <div className="rcv-hint">
              Recorded as a receipt with your reason; no PO is created.
            </div>
            {adhocDone && (
              <div className="rcv-done" data-testid="receive-success">
                {adhocDone}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
