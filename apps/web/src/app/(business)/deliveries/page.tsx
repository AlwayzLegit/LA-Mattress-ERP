'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { formatMoney } from '@jetnine/shared';
import { ApiError, api } from '@/lib/api';
import {
  Alert,
  Button,
  Dialog,
  Field,
  Input,
  Kbd,
  LinkButton,
  LoadingRows,
  StatusChip,
} from '@/components/ui';
import type { StatusKey } from '@/lib/design-tokens';

/**
 * Deliveries board (redesign Phase 8, README §3.4, canvas 7a–7d).
 * Dispatch at the warehouse and the store manager checking dates:
 * "how full is each day, and what is not ready to load?" Every day
 * header answers the first half with `n / cap` and a 4px bar; every
 * card answers the second with its status chip. Week is the working
 * view (cards, drag, keyboard M), Month the overview (fractions and
 * roll-ups, no cards). The cap is soft: a drop over it is allowed, the
 * day turns red, and the dispatcher writes a one-line note that prints
 * on the day sheet.
 */

interface DeliveryRow {
  id: string;
  orderId: string;
  kind?: 'delivery' | 'return_pickup';
  rmaNumber?: string | null;
  orderNumber: string;
  customerName: string | null;
  scheduledDate: string;
  windowStart: string | null;
  windowEnd: string | null;
  status: string;
  route: string | null;
  routePosition: number | null;
  notes: string | null;
  addressCity: string | null;
  balanceDueCents: number;
  lines: { id: string; description: string; quantity: number }[];
}
interface Capacity {
  cap: number;
  days: { date: string; booked: number; remaining: number }[];
}
type Mode = 'week' | 'month';

const LIVE = new Set(['scheduled', 'loaded', 'out_for_delivery']);
const MOVABLE = new Set(['scheduled', 'loaded']);

function toDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseDay(s: string): Date {
  return new Date(`${s}T12:00:00`);
}
function addDays(s: string, n: number): string {
  const d = parseDay(s);
  d.setDate(d.getDate() + n);
  return toDay(d);
}
/** Monday of the week holding `s`. */
function mondayOf(s: string): string {
  const d = parseDay(s);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return toDay(d);
}
function fmtShort(s: string, withWeekday = true): string {
  return parseDay(s).toLocaleDateString('en-US', {
    ...(withWeekday ? { weekday: 'short' } : {}),
    month: 'short',
    day: 'numeric',
  });
}
function hhmm(t: string | null): string {
  return t ? t.slice(0, 5) : '';
}
function chipFor(r: DeliveryRow): { status: StatusKey; label: string } {
  if (r.kind === 'return_pickup') return { status: 'waiting', label: 'Pickup' };
  switch (r.status) {
    case 'scheduled':
      return { status: 'scheduled', label: 'Scheduled' };
    case 'loaded':
      return { status: 'scheduled', label: 'Loaded' };
    case 'out_for_delivery':
      return { status: 'scheduled', label: 'Out for delivery' };
    case 'delivered':
      return { status: 'fulfilled', label: 'Delivered' };
    case 'failed':
      return { status: 'risk', label: 'Failed' };
    default:
      return { status: 'draft', label: r.status };
  }
}
function capTone(booked: number, cap: number): 'ok' | 'near' | 'over' | 'none' {
  if (booked === 0) return 'none';
  if (booked > cap) return 'over';
  if (booked >= Math.max(1, cap - 2)) return 'near';
  return 'ok';
}
/** "Over cap 2026-09-12: …" lines written by the reschedule onto the stop's notes. */
function capNotesFor(rows: DeliveryRow[], date: string): string[] {
  const out: string[] = [];
  for (const r of rows) {
    for (const line of (r.notes ?? '').split('\n')) {
      const m = /^Over cap (\d{4}-\d{2}-\d{2}): (.+)$/.exec(line.trim());
      if (m && m[1] === date) out.push(m[2]!);
    }
  }
  return out;
}

export default function DeliveriesBoardPage() {
  // useSearchParams needs a Suspense boundary so the server and the first
  // client render agree on the view and the anchor day.
  return (
    <Suspense fallback={<LoadingRows rows={6} height={48} what="The board" />}>
      <DeliveriesBoard />
    </Suspense>
  );
}

function DeliveriesBoard() {
  const router = useRouter();
  const search = useSearchParams();
  const today = useMemo(() => toDay(new Date()), []);
  const [mode, setMode] = useState<Mode>(search.get('view') === 'month' ? 'month' : 'week');
  const [anchor, setAnchor] = useState<string>(() => {
    const d = search.get('d');
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : today;
  });
  const [rows, setRows] = useState<DeliveryRow[] | null>(null);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<{ id: string; x: number; y: number } | null>(null);
  const [capAsk, setCapAsk] = useState<{
    id: string;
    date: string;
    from: string;
    message: string;
  } | null>(null);
  const [capNote, setCapNote] = useState('');
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const start = mondayOf(anchor);
  const dayCount = mode === 'week' ? 7 : 35;
  const days = useMemo(
    () => Array.from({ length: dayCount }, (_, i) => addDays(start, i)),
    [start, dayCount],
  );
  const end = days[days.length - 1]!;

  useEffect(() => {
    const p = new URLSearchParams();
    if (mode !== 'week') p.set('view', mode);
    if (anchor !== today) p.set('d', anchor);
    const qs = p.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [mode, anchor, today]);

  useEffect(() => {
    const mine = ++seq.current;
    Promise.all([
      api<DeliveryRow[]>(`/v1/deliveries?from=${start}&to=${end}&limit=2000`),
      api<Capacity>(`/v1/deliveries/capacity?from=${start}&to=${end}`).catch(() => null),
    ])
      .then(([list, cap]) => {
        if (seq.current !== mine) return;
        setRows(list.filter((r) => r.status !== 'cancelled'));
        setCapacity(cap);
        setError(null);
      })
      .catch((e) => {
        if (seq.current !== mine) return;
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [start, end, tick]);

  useEffect(() => {
    if (!menuFor) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuFor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuFor(null);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    menuRef.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuFor]);

  const cap = capacity?.cap ?? 15;
  const byDay = useMemo(() => {
    const m = new Map<string, DeliveryRow[]>();
    for (const r of rows ?? []) m.set(r.scheduledDate, [...(m.get(r.scheduledDate) ?? []), r]);
    for (const list of m.values()) {
      list.sort(
        (a, b) =>
          (a.routePosition ?? 999) - (b.routePosition ?? 999) ||
          (a.windowStart ?? '').localeCompare(b.windowStart ?? ''),
      );
    }
    return m;
  }, [rows]);
  // Every stop that used (or will use) the truck counts against the day:
  // delivered and failed stops included, cancelled ones not. The capacity
  // endpoint only counts live stops, so it is a floor, never the whole story.
  const bookedOn = useCallback(
    (date: string) =>
      Math.max(
        capacity?.days.find((d) => d.date === date)?.booked ?? 0,
        (byDay.get(date) ?? []).filter((r) => r.status !== 'cancelled').length,
      ),
    [capacity, byDay],
  );
  const overDays = days.filter((d) => bookedOn(d) > cap);

  const move = useCallback(
    async (id: string, date: string, opts?: { note?: string; silent?: boolean }) => {
      const row = rows?.find((r) => r.id === id);
      if (!row || row.scheduledDate === date) return;
      if (!MOVABLE.has(row.status)) {
        toast.error(`${row.orderNumber} is ${row.status.replace(/_/g, ' ')} — it cannot move`);
        return;
      }
      setBusy(true);
      try {
        await api(`/v1/deliveries/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(
            opts?.note
              ? { scheduledDate: date, confirmOverCapacity: true, overCapacityNote: opts.note }
              : { scheduledDate: date },
          ),
        });
        setCapAsk(null);
        setCapNote('');
        setTick((n) => n + 1);
        if (!opts?.silent) {
          const from = row.scheduledDate;
          toast.success(`${row.orderNumber} moved to ${fmtShort(date)}`, {
            action: { label: 'Undo', onClick: () => void move(id, from, { silent: true }) },
          });
        }
      } catch (e) {
        if (e instanceof ApiError && e.code === 'OVER_CAPACITY') {
          setCapAsk({ id, date, from: row.scheduledDate, message: e.message });
        } else {
          toast.error(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setBusy(false);
      }
    },
    [rows],
  );

  const shift = (n: number) => setAnchor((a) => addDays(a, mode === 'week' ? 7 * n : 35 * n));
  const rangeLabel =
    mode === 'week'
      ? `${fmtShort(start)} – ${fmtShort(end)}`
      : `${fmtShort(start, false)} – ${fmtShort(end, false)} · 5 weeks`;
  const sheetDay = days.includes(today) ? today : start;

  return (
    <div className="db" data-testid="deliveries-board">
      <header className="db-head">
        <div>
          <div className="t-label">Sell</div>
          <div className="db-title-row">
            <h1 className="db-title">Deliveries</h1>
            <span className="db-range" data-testid="db-range">
              {rangeLabel}
            </span>
          </div>
        </div>
        <div className="db-controls">
          <div className="db-seg" role="group" aria-label="View">
            <button
              type="button"
              aria-pressed={mode === 'week'}
              onClick={() => setMode('week')}
              data-testid="db-mode-week"
            >
              Week
            </button>
            <button
              type="button"
              aria-pressed={mode === 'month'}
              onClick={() => setMode('month')}
              data-testid="db-mode-month"
            >
              Month
            </button>
          </div>
          <div className="db-nav">
            <Button size="sm" onClick={() => shift(-1)} aria-label={`Previous ${mode}`}>
              ‹
            </Button>
            <Button size="sm" onClick={() => setAnchor(today)} data-testid="db-today">
              Today
            </Button>
            <Button size="sm" onClick={() => shift(1)} aria-label={`Next ${mode}`}>
              ›
            </Button>
          </div>
          <span className="db-divider" aria-hidden />
          <LinkButton href={`/deliveries/confirm?date=${sheetDay}`} size="sm">
            Confirm calls
          </LinkButton>
          <LinkButton href={`/deliveries/dispatch?date=${sheetDay}`} size="sm">
            Dispatch
          </LinkButton>
          <LinkButton href={`/deliveries/day/${sheetDay}`} size="sm" data-testid="db-print-day">
            Print day sheet
          </LinkButton>
          <LinkButton href="/deliveries/search" size="sm" variant="ghost">
            Search
          </LinkButton>
        </div>
      </header>

      {error && <Alert tone="error">{error}</Alert>}
      {overDays.length > 0 && (
        <div className="db-banner" role="status" data-testid="db-over-banner">
          <span className="db-banner-glyph" aria-hidden>
            ▲
          </span>
          <div>
            <strong>Over capacity.</strong>{' '}
            {overDays.map((d, i) => {
              const notes = capNotesFor(byDay.get(d) ?? [], d);
              return (
                <span key={d}>
                  {i > 0 ? ' · ' : ''}
                  {fmtShort(d)} has {bookedOn(d)} stops against a cap of {cap}
                  {notes.length > 0 ? ` — ${notes.join(' · ')}` : ' — no note yet'}.
                </span>
              );
            })}{' '}
            Move a stop or confirm the note before printing the day sheet.
          </div>
        </div>
      )}

      <div className={`db-grid${mode === 'month' ? ' is-month' : ''}`} data-testid="db-grid">
        {days.map((d) => {
          const list = byDay.get(d) ?? [];
          const booked = bookedOn(d);
          const tone = capTone(booked, cap);
          const isTarget = dragId != null && overDay === d;
          const dragging = dragId ? rows?.find((r) => r.id === dragId) : null;
          const previewTo = booked + (dragging && dragging.scheduledDate !== d ? 1 : 0);
          const weekend = [0, 6].includes(parseDay(d).getDay());
          const notes = capNotesFor(list, d);
          const due = list
            .filter((r) => LIVE.has(r.status) && r.kind !== 'return_pickup')
            .reduce((n, r) => n + r.balanceDueCents, 0);
          return (
            <section
              key={d}
              className={[
                'db-day',
                d === today ? 'is-today' : '',
                weekend ? 'is-weekend' : '',
                tone === 'over' ? 'is-over' : '',
                isTarget ? 'is-target' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-label={`${fmtShort(d)} · ${booked} of ${cap} stops`}
              data-testid="db-day"
              data-date={d}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                if (overDay !== d) setOverDay(d);
              }}
              onDragLeave={(e) => {
                if (overDay === d && !e.currentTarget.contains(e.relatedTarget as Node)) {
                  setOverDay(null);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = dragId ?? e.dataTransfer.getData('text/plain');
                setDragId(null);
                setOverDay(null);
                if (id) void move(id, d);
              }}
            >
              <div className="db-day-head">
                <Link href={`/deliveries/day/${d}`} title="Open the printable day sheet">
                  {mode === 'week' ? fmtShort(d) : fmtShort(d)}
                </Link>
                <span className={`db-cap is-${tone}`} data-testid="db-cap">
                  {booked === 0 && mode === 'month' ? 'No truck' : `${booked} / ${cap}`}
                </span>
              </div>
              <div className="db-bar" aria-hidden>
                <div
                  className={`db-bar-fill${tone === 'near' ? ' is-near' : tone === 'over' ? ' is-over' : ''}`}
                  style={{ width: `${Math.min(100, (booked / Math.max(1, cap)) * 100)}%` }}
                />
              </div>

              {mode === 'week' ? (
                <>
                  <div className="db-cards">
                    {isTarget && (
                      <div className="db-drop-hint" data-testid="db-drop-hint">
                        Drop here · {booked} → {previewTo} / {cap}
                      </div>
                    )}
                    {list.map((r) => {
                      const chip = chipFor(r);
                      const movable = MOVABLE.has(r.status);
                      const pickup = r.kind === 'return_pickup';
                      return (
                        <a
                          key={r.id}
                          href={`/deliveries/${r.id}`}
                          className={[
                            'db-card',
                            pickup ? 'is-pickup' : '',
                            r.status === 'failed' ? 'is-risk' : '',
                            r.status === 'delivered' ? 'is-done' : '',
                            dragId === r.id ? 'is-dragging' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          data-testid="delivery-card"
                          data-status={r.status}
                          draggable={movable}
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/plain', r.id);
                            e.dataTransfer.effectAllowed = 'move';
                            setDragId(r.id);
                          }}
                          onDragEnd={() => {
                            setDragId(null);
                            setOverDay(null);
                          }}
                          onClick={(e) => {
                            e.preventDefault();
                            router.push(`/deliveries/${r.id}`);
                          }}
                          onKeyDown={(e) => {
                            if ((e.key === 'm' || e.key === 'M') && movable) {
                              e.preventDefault();
                              const rect = e.currentTarget.getBoundingClientRect();
                              setMenuFor({
                                id: r.id,
                                x: rect.left + window.scrollX,
                                y: rect.bottom + window.scrollY + 4,
                              });
                            }
                          }}
                          title={
                            movable
                              ? 'Drag the handle to another day, or press M to pick one'
                              : `${chip.label} — this stop no longer moves`
                          }
                        >
                          <span className="db-grip" aria-hidden>
                            ⋮⋮
                          </span>
                          <span>
                            <span className="db-card-row">
                              <span className="db-card-num">
                                {pickup ? (r.rmaNumber ?? r.orderNumber) : r.orderNumber}
                              </span>
                              {(r.windowStart || r.windowEnd) && (
                                <span className="db-card-win">
                                  {hhmm(r.windowStart)}–{hhmm(r.windowEnd)}
                                </span>
                              )}
                            </span>
                            <span className="db-card-cust">
                              {r.customerName ?? '—'}
                              {r.addressCity ? ` · ${r.addressCity}` : ''}
                            </span>
                            <span className="db-card-row">
                              <StatusChip status={chip.status} label={chip.label} />
                              {!pickup && r.balanceDueCents > 0 && LIVE.has(r.status) && (
                                <span className="db-card-due">
                                  {formatMoney(r.balanceDueCents)} due
                                </span>
                              )}
                            </span>
                          </span>
                        </a>
                      );
                    })}
                    {list.length === 0 && !isTarget && (
                      <Link
                        href={`/orders?status=Reserved&written=all`}
                        className="db-empty"
                        data-testid="db-empty-day"
                      >
                        No stops · Schedule here
                      </Link>
                    )}
                  </div>
                  {notes.length > 0 && (
                    <div className="db-capnote" data-testid="db-capnote">
                      <strong>Over cap:</strong> {notes.join(' · ')}
                    </div>
                  )}
                </>
              ) : (
                <>
                  {booked === 0 && list.length === 0 ? (
                    <div className="db-notruck">· No stops</div>
                  ) : (
                    <div className="db-roll">
                      {(
                        [
                          ['scheduled', '◷', 'Scheduled'],
                          ['out_for_delivery', '◷', 'Out'],
                          ['pickup', '◷', 'Pickups'],
                          ['delivered', '✓', 'Delivered'],
                          ['failed', '▲', 'Failed'],
                        ] as const
                      ).map(([key, g, label]) => {
                        const n =
                          key === 'pickup'
                            ? list.filter((r) => r.kind === 'return_pickup').length
                            : key === 'scheduled'
                              ? list.filter(
                                  (r) =>
                                    r.kind !== 'return_pickup' &&
                                    (r.status === 'scheduled' || r.status === 'loaded'),
                                ).length
                              : list.filter((r) => r.kind !== 'return_pickup' && r.status === key)
                                  .length;
                        if (n === 0) return null;
                        return (
                          <div key={key} className="db-roll-row">
                            <span>
                              <span className="g" aria-hidden>
                                {g}
                              </span>
                              {label}
                            </span>
                            <span>{n}</span>
                          </div>
                        );
                      })}
                      {due > 0 && (
                        <div className="db-roll-due">
                          <span>Due at door</span>
                          <span>{formatMoney(due)}</span>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </section>
          );
        })}
      </div>

      <div className="db-foot">
        <span>
          Drag the <strong>⋮⋮</strong> handle to another day to reschedule, or focus a card and
          press <Kbd keys="M" />. Scheduled and Loaded cards move; Delivered and Failed do not.
        </span>
        <span>
          Capacity is a soft cap of <strong>{cap}</strong> stops per day.{' '}
          <strong>
            {Math.max(1, cap - 2)}–{cap} amber
          </strong>{' '}
          · <strong>over red, note required</strong>
        </span>
      </div>

      {menuFor && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Move to"
          className="menu db-menu"
          style={{ left: menuFor.x, top: menuFor.y }}
          data-testid="db-move-menu"
        >
          <div className="acting-menu-head">Move to…</div>
          {Array.from({ length: 14 }, (_, i) => addDays(today, i)).map((d) => {
            const b = bookedOn(d);
            const t = capTone(b, cap);
            return (
              <button
                key={d}
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  const id = menuFor.id;
                  setMenuFor(null);
                  void move(id, d);
                }}
                onKeyDown={(e) => {
                  const items = Array.from(
                    menuRef.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [],
                  );
                  const i = items.indexOf(e.currentTarget);
                  if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
                  if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
                }}
              >
                <span style={{ flex: 1 }}>{fmtShort(d)}</span>
                <span className={`db-cap is-${t}`}>
                  {b} / {cap}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {capAsk && (
        <Dialog
          size="sm"
          title={`${fmtShort(capAsk.date)} is over the cap`}
          description={`${fmtShort(capAsk.date)} already has ${bookedOn(capAsk.date)} stops against a cap of ${cap}; this move makes it ${bookedOn(capAsk.date) + 1}. Say why in one line — it prints on the day sheet.`}
          onClose={() => {
            setCapAsk(null);
            setCapNote('');
          }}
          testId="db-cap-dialog"
          foot={
            <>
              <Button
                onClick={() => {
                  setCapAsk(null);
                  setCapNote('');
                }}
              >
                Keep it on {fmtShort(capAsk.from)}
              </Button>
              <Button
                variant="primary"
                disabled={busy || !capNote.trim()}
                onClick={() => void move(capAsk.id, capAsk.date, { note: capNote.trim() })}
                data-testid="db-cap-confirm"
              >
                Move anyway
              </Button>
            </>
          }
        >
          <Field label="Why the day goes over" required>
            <Input
              value={capNote}
              onChange={(e) => setCapNote(e.target.value)}
              placeholder="e.g. second truck requested for the afternoon"
              maxLength={140}
              autoFocus
              data-testid="db-cap-note"
            />
          </Field>
        </Dialog>
      )}
    </div>
  );
}
