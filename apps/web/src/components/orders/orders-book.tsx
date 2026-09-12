'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PenLine } from 'lucide-react';
import { formatMoney } from '@jetnine/shared';
import { api } from '@/lib/api';
import { useOptionalActingStore } from '@/lib/acting-store';
import { rangeFor } from '@/lib/date-range';
import { Money } from '@/components/money';
import {
  Alert,
  Button,
  Field,
  Input,
  Kbd,
  LinkButton,
  LoadingRows,
  Select,
  StatusChip,
} from '@/components/ui';
import { STATUS_OPTIONS, chipFor, fmtDay } from './order-format';

/**
 * Orders book (redesign Phase 6, README §3.2, canvas 5). A salesperson
 * with a customer on the phone, or a manager scanning the store's book:
 * "where is this order, and can I still change it?" The list answers
 * with the status chip and the reserved bar in the same row; the
 * slide-over (`/orders/[id]`, rendered as children) answers the rest.
 *
 * Toolbar: Store (default = the signed-in store), Status, Written
 * (7/30/90/all), Salesperson, Find, Balance due only, Clear filters;
 * active filters as removable chips. Every column sorts with
 * `aria-sort`; the order number is a real anchor; ↑↓ move, ↵ opens.
 */

export interface OrderListRow {
  id: string;
  number: string;
  customerName: string;
  customerPhone: string | null;
  displayStatus: string;
  poNumber: string | null;
  deliveryDate: string | null;
  balanceDueCents: number;
  creditDueCents: number;
  salespersonName: string | null;
  salespersonMembershipId: string | null;
  locationId: string;
  locationName: string | null;
  lockedAt: string | null;
  totalCents: number;
  createdAt: string;
  lineSummary: { units: number; reserved: number; fulfilled: number; specialOrder: number } | null;
}
interface ListPage {
  data: OrderListRow[];
  nextCursor: string | null;
  summary?: { count: number; balanceDueCents: number };
}
interface LocationRow {
  id: string;
  name: string;
  locationType?: string;
}
interface MemberRow {
  membershipId: string;
  name: string | null;
  status: string;
}

const WRITTEN = [
  { value: '7', label: 'Last 7 days', preset: 'last7' },
  { value: '30', label: 'Last 30 days', preset: 'last30' },
  { value: '90', label: 'Last 90 days', preset: 'last90' },
  { value: 'all', label: 'All time', preset: 'all' },
] as const;
const DEFAULT_WRITTEN = '30';

const COLUMNS: { key: string; label: string; align?: 'right' }[] = [
  { key: 'number', label: 'Order' },
  { key: 'customer', label: 'Customer' },
  { key: 'store', label: 'Store' },
  { key: 'status', label: 'Status' },
  { key: 'reserved', label: 'Reserved' },
  { key: 'deliveryDate', label: 'Promised' },
  { key: 'salesperson', label: 'Salesperson' },
  { key: 'total', label: 'Total', align: 'right' },
  { key: 'balanceDue', label: 'Balance', align: 'right' },
];
/** Columns whose natural first click is newest / largest first. */
const DESC_FIRST = new Set(['balanceDue', 'total', 'deliveryDate']);

interface Filters {
  /** '' = signed-in store (the default), 'all', or a location id. */
  store: string;
  status: string;
  written: string;
  rep: string;
  q: string;
  due: boolean;
  mine: boolean;
  sort: string;
  dir: 'asc' | 'desc';
}

function readFilters(): Filters {
  const p =
    typeof window === 'undefined'
      ? new URLSearchParams()
      : new URLSearchParams(window.location.search);
  const status =
    p.get('status') ?? p.get('display') ?? (p.get('view') === 'past_due' ? 'past_due' : '');
  const written = p.get('written') ?? DEFAULT_WRITTEN;
  return {
    store: p.get('store') ?? '',
    status,
    written: WRITTEN.some((w) => w.value === written) ? written : DEFAULT_WRITTEN,
    rep: p.get('rep') ?? '',
    q: p.get('q') ?? '',
    due: p.get('due') === '1',
    mine: p.get('mine') === '1',
    sort: p.get('sort') ?? '',
    dir: p.get('dir') === 'desc' ? 'desc' : 'asc',
  };
}

function writeFilters(f: Filters): string {
  const p = new URLSearchParams();
  if (f.store) p.set('store', f.store);
  if (f.status) p.set('status', f.status);
  if (f.written !== DEFAULT_WRITTEN) p.set('written', f.written);
  if (f.rep) p.set('rep', f.rep);
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.due) p.set('due', '1');
  if (f.mine) p.set('mine', '1');
  if (f.sort) {
    p.set('sort', f.sort);
    p.set('dir', f.dir);
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function OrdersBook({ children }: { children?: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? '/orders';
  const acting = useOptionalActingStore();
  const storeReady = !acting || acting.meReady;
  const myStore = acting?.store ?? null;

  const [f, setF] = useState<Filters>(() => readFilters());
  const [rows, setRows] = useState<OrderListRow[] | null>(null);
  const [summary, setSummary] = useState<{ count: number; balanceDueCents: number } | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [hi, setHi] = useState(0);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const tableRef = useRef<HTMLTableElement>(null);
  const sheetOpen = /^\/orders\/[^/]+$/.test(pathname) && !pathname.endsWith('/new');

  // The effective store filter: an explicit choice, else the signed-in store.
  const storeId = f.store === 'all' ? null : f.store || myStore?.id || null;
  const storeName =
    storeId == null
      ? null
      : (locations.find((l) => l.id === storeId)?.name ??
        (myStore?.id === storeId ? myStore.name : null));

  useEffect(() => {
    void api<LocationRow[]>('/v1/business/locations')
      .then(setLocations)
      .catch(() => setLocations([]));
    void api<MemberRow[]>('/v1/business/members')
      .then((m) => setMembers(m.filter((x) => x.status === 'active' && x.name?.trim())))
      .catch(() => setMembers([]));
  }, []);

  const query = useCallback(
    (cursor: string | null) => {
      const p = new URLSearchParams({ limit: '50' });
      if (f.q.trim()) p.set('q', f.q.trim());
      if (f.status === 'past_due') p.set('view', 'past_due');
      else if (f.status) p.set('display', f.status);
      if (f.rep) p.set('salespersonMembershipId', f.rep);
      if (f.mine) p.set('mine', '1');
      if (f.due) p.set('balanceDue', '1');
      if (storeId) p.set('locationId', storeId);
      const w = WRITTEN.find((x) => x.value === f.written);
      if (w && w.preset !== 'all') {
        const r = rangeFor(w.preset);
        p.set('start', r.start);
        p.set('end', r.end);
      }
      if (f.sort) {
        p.set('sort', f.sort);
        p.set('dir', f.dir);
      }
      if (cursor) p.set('cursor', cursor);
      return api<ListPage>(`/v1/orders/list-view?${p.toString()}`);
    },
    [f, storeId],
  );

  // Filters live in the URL (replace, no history spam); a sequence counter
  // drops stale responses. Debounced while typing.
  useEffect(() => {
    if (!storeReady) return;
    const mine = ++seq.current;
    const qs = writeFilters(f);
    if (typeof window !== 'undefined' && window.location.search !== qs) {
      router.replace(`${pathname}${qs}`, { scroll: false });
    }
    const t = setTimeout(
      () => {
        query(null)
          .then((page) => {
            if (seq.current !== mine) return;
            setRows(page.data);
            setSummary(page.summary ?? null);
            setNextCursor(page.nextCursor);
            setHi(0);
            setError(null);
          })
          .catch((e) => {
            if (seq.current !== mine) return;
            setError(e instanceof Error ? e.message : String(e));
          });
      },
      rows === null ? 0 : 220,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f, storeId, storeReady, tick]);

  // The slide-over reports mutations (payment, cancel, unlock) here.
  useEffect(() => {
    const onChange = () => setTick((n) => n + 1);
    window.addEventListener('erp:orders-changed', onChange);
    return () => window.removeEventListener('erp:orders-changed', onChange);
  }, []);

  const open = useCallback(
    (id: string) => {
      router.push(`/orders/${id}${writeFilters(f)}`);
    },
    [router, f],
  );

  // ↑↓ move the highlight, ↵ opens, while nothing else has the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheetOpen || !rows || rows.length === 0) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (typing && t?.getAttribute('data-testid') !== 'orders-search') return;
        e.preventDefault();
        setHi((h) => {
          const next =
            e.key === 'ArrowDown' ? Math.min(h + 1, rows.length - 1) : Math.max(h - 1, 0);
          tableRef.current
            ?.querySelectorAll('tbody tr[data-testid="order-row"]')
            [next]?.scrollIntoView({ block: 'nearest' });
          return next;
        });
      } else if (e.key === 'Enter' && !typing) {
        const row = rows[hi];
        if (row) {
          e.preventDefault();
          open(row.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, hi, open, sheetOpen]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await query(nextCursor);
      setRows((prev) => [...(prev ?? []), ...page.data]);
      setNextCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  function toggleSort(key: string) {
    setRows(null);
    setF((prev) =>
      prev.sort === key
        ? { ...prev, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { ...prev, sort: key, dir: DESC_FIRST.has(key) ? 'desc' : 'asc' },
    );
  }

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) =>
    setF((prev) => ({ ...prev, [k]: v }));
  const reset = () =>
    setF((prev) => ({
      ...prev,
      store: '',
      status: '',
      written: DEFAULT_WRITTEN,
      rep: '',
      q: '',
      due: false,
      mine: false,
    }));

  // Removable chips for everything that differs from the defaults.
  const chips: { key: string; label: string; remove: () => void }[] = [];
  if (f.store) {
    chips.push({
      key: 'store',
      label: f.store === 'all' ? 'All stores' : (storeName ?? 'Store'),
      remove: () => set('store', ''),
    });
  }
  if (f.status) {
    chips.push({
      key: 'status',
      label: STATUS_OPTIONS.find((o) => o.value === f.status)?.label ?? f.status,
      remove: () => set('status', ''),
    });
  }
  if (f.written !== DEFAULT_WRITTEN) {
    chips.push({
      key: 'written',
      label: WRITTEN.find((w) => w.value === f.written)?.label ?? f.written,
      remove: () => set('written', DEFAULT_WRITTEN),
    });
  }
  if (f.rep) {
    chips.push({
      key: 'rep',
      label: members.find((m) => m.membershipId === f.rep)?.name ?? 'Salesperson',
      remove: () => set('rep', ''),
    });
  }
  if (f.mine) chips.push({ key: 'mine', label: 'My orders', remove: () => set('mine', false) });
  if (f.due) chips.push({ key: 'due', label: 'Balance due', remove: () => set('due', false) });
  if (f.q.trim()) chips.push({ key: 'q', label: `“${f.q.trim()}”`, remove: () => set('q', '') });
  const filtered = chips.length > 0;

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const sortLabel = f.sort
    ? `${COLUMNS.find((c) => c.key === f.sort)?.label.toLowerCase() ?? f.sort} ${f.dir === 'asc' ? '↑' : '↓'}`
    : 'newest first';
  const summaryLine = summary
    ? `${rows?.length ?? 0} of ${summary.count} · ${formatMoney(summary.balanceDueCents)} balance due`
    : null;

  return (
    <div className="ob" data-testid="orders-book">
      <header className="ob-head">
        <div>
          <div className="t-label">Sell</div>
          <div className="ob-title-row">
            <h1 className="ob-title">Orders</h1>
            {summaryLine && (
              <span className="ob-summary" data-testid="orders-summary">
                {summaryLine}
              </span>
            )}
          </div>
        </div>
        <div className="ob-head-actions">
          <LinkButton href="/orders/new" variant="primary">
            <PenLine size={14} aria-hidden />
            New sale
          </LinkButton>
        </div>
      </header>

      <section className="ob-card" aria-label="Orders">
        <div className="ob-toolbar">
          <Field label="Store">
            <Select
              value={f.store || (myStore ? myStore.id : 'all')}
              onChange={(e) => set('store', e.target.value === myStore?.id ? '' : e.target.value)}
              data-testid="orders-store-filter"
            >
              <option value="all">All stores</option>
              {(locations.length > 0 ? locations : myStore ? [myStore] : []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.id === myStore?.id ? ' — your store' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select
              value={f.status}
              onChange={(e) => set('status', e.target.value)}
              data-testid="orders-status-filter"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Written">
            <Select
              value={f.written}
              onChange={(e) => set('written', e.target.value)}
              data-testid="orders-written-filter"
            >
              {WRITTEN.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Salesperson">
            <Select
              value={f.rep}
              onChange={(e) => set('rep', e.target.value)}
              data-testid="orders-rep-filter"
            >
              <option value="">Anyone</option>
              {members.map((m) => (
                <option key={m.membershipId} value={m.membershipId}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Find" className="ob-find">
            <Input
              value={f.q}
              onChange={(e) => set('q', e.target.value)}
              placeholder="Order number, customer or phone"
              data-testid="orders-search"
              autoComplete="off"
            />
          </Field>
          <label className="ob-check">
            <input
              type="checkbox"
              checked={f.due}
              onChange={(e) => set('due', e.target.checked)}
              data-testid="orders-due-filter"
            />
            Balance due only
          </label>
          {filtered && (
            <Button variant="ghost" size="sm" onClick={reset} data-testid="clear-filters">
              Clear filters
            </Button>
          )}
        </div>

        {filtered && (
          <div className="ob-chips" data-testid="filter-chips">
            <span className="ob-chips-label">Showing</span>
            {chips.map((c) => (
              <span key={c.key} className="ob-chip" data-testid="filter-chip">
                {c.label}
                <button type="button" onClick={c.remove} aria-label={`Remove filter ${c.label}`}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="ob-list">
          {error && (
            <div style={{ padding: 12 }}>
              <Alert
                tone="error"
                action={
                  <Button size="sm" onClick={() => setTick((n) => n + 1)}>
                    Retry
                  </Button>
                }
              >
                {error}
              </Alert>
            </div>
          )}
          {!rows && !error && (
            <div style={{ padding: 12 }}>
              <LoadingRows rows={8} height={36} what="Orders" />
            </div>
          )}
          {rows && (
            <table
              className="table table-sticky ob-table"
              data-testid="orders-table"
              ref={tableRef}
            >
              <thead>
                <tr>
                  {COLUMNS.map((c) => {
                    const on = f.sort === c.key;
                    return (
                      <th
                        key={c.key}
                        className={c.align === 'right' ? 'num' : undefined}
                        aria-sort={on ? (f.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                      >
                        <button
                          type="button"
                          className={`ob-sort${on ? ' is-on' : ''}`}
                          onClick={() => toggleSort(c.key)}
                          data-testid={`sort-${c.key}`}
                        >
                          {c.label}
                          <span className="ob-sort-arrow" aria-hidden>
                            {on ? (f.dir === 'asc' ? '▲' : '▼') : ''}
                          </span>
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const chip = chipFor(r.displayStatus, { deliveryDate: r.deliveryDate, today });
                  const units = r.lineSummary?.units ?? 0;
                  const done = Math.min(
                    units,
                    (r.lineSummary?.reserved ?? 0) + (r.lineSummary?.fulfilled ?? 0),
                  );
                  const pct = units > 0 ? Math.round((done / units) * 100) : 0;
                  const resTone =
                    units === 0 ? 'none' : done >= units ? 'full' : done > 0 ? 'part' : 'zero';
                  const cancelled = r.displayStatus === 'Cancelled';
                  return (
                    <tr
                      key={r.id}
                      data-testid="order-row"
                      className={i === hi ? 'is-selected' : undefined}
                      onClick={() => open(r.id)}
                      onMouseEnter={() => setHi(i)}
                    >
                      <td className="ob-num-cell">
                        <Link
                          href={`/orders/${r.id}${writeFilters(f)}`}
                          className="ob-num"
                          data-testid="order-number-link"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {r.number}
                        </Link>
                        {r.lockedAt && (
                          <span
                            className="ob-lock"
                            title="Locked — delivery ticket printed"
                            aria-label="Locked"
                          >
                            ◷
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="ob-customer">{r.customerName}</span>
                        {r.customerPhone && <span className="ob-phone">{r.customerPhone}</span>}
                      </td>
                      <td className="ob-muted">{r.locationName ?? '—'}</td>
                      <td>
                        <StatusChip status={chip.status} label={chip.label} />
                      </td>
                      <td className="ob-res-cell">
                        {units > 0 ? (
                          <div className="ob-res" title={`${done} of ${units} units reserved`}>
                            <div className="ob-res-bar" aria-hidden>
                              <div
                                className={`ob-res-fill is-${resTone}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="ob-res-frac">
                              {done}/{units}
                            </span>
                          </div>
                        ) : (
                          <span className="ob-muted">—</span>
                        )}
                      </td>
                      <td className="ob-mono ob-muted">{fmtDay(r.deliveryDate)}</td>
                      <td className="ob-muted">{r.salespersonName ?? '—'}</td>
                      <td className="num ob-mono">
                        <Money cents={r.totalCents} />
                      </td>
                      <td
                        className={`num ob-mono ob-balance${!cancelled && r.balanceDueCents > 0 ? ' is-due' : ''}`}
                      >
                        {cancelled ? (
                          '—'
                        ) : r.balanceDueCents > 0 ? (
                          <Money cents={r.balanceDueCents} />
                        ) : r.creditDueCents > 0 ? (
                          <span className="ob-credit">
                            Credit <Money cents={r.creditDueCents} />
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={COLUMNS.length} className="ob-empty">
                      <div className="ob-empty-title">No orders match</div>
                      <div>Widen the date range or clear a filter.</div>
                      {filtered && (
                        <Button size="sm" onClick={reset} style={{ marginTop: 10 }}>
                          Clear filters
                        </Button>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          {nextCursor && (
            <div className="ob-more">
              <Button
                size="sm"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                data-testid="orders-load-more"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </div>

        <div className="ob-foot">
          <span data-testid="orders-footer">
            {summary ? `${summary.count} orders` : '…'} · sorted by {sortLabel}
            {myStore && storeId === myStore.id
              ? ` · ${myStore.name} is your store, so it is the default filter`
              : ''}
          </span>
          <span className="ob-foot-keys">
            <Kbd keys="up" />
            <Kbd keys="down" /> move · <Kbd keys="enter" /> open · <Kbd keys="esc" /> close
          </span>
        </div>
      </section>
      {children}
    </div>
  );
}
