'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Dialog, Field, StatusChip } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { Panel, pctDelta, ShimmerRows } from '../../dashboard/owner/owner-kit';
import { usdCents } from '../../dashboard/shared/cash-pickups';
import { clockTime, plural, tenderMeta } from '../../dashboard/shared/kit';

/**
 * The close-out sheet — the Z-report (redesign Phase 10, README §3.5).
 * One store, one store-local day: six tiles against the same weekday
 * last week, the tender mix with the refund line, the cash drawers with
 * their variance and the inline exception, what the 10pm close did, the
 * day's refunds and cancellations, and the manager's sign-off. Signing
 * records a name and a time; every exception stays open on the register
 * until it is acknowledged there.
 */

export interface CloseOutDrawer {
  id: string;
  number: number;
  openedAt: string;
  closedAt: string | null;
  openedBy: string | null;
  closedBy: string | null;
  openingFloatCents: number;
  expectedCashCents: number | null;
  countedCashCents: number | null;
  varianceCents: number | null;
  status: 'open' | 'clean' | 'short' | 'over' | 'suspended';
  closeAttempts: number;
  recount: { by: string; at: string } | null;
  reason: { text: string; by: string; at: string } | null;
}

export interface CloseOutReport {
  date: string;
  today: string;
  location: { id: string; name: string; timezone: string };
  locations: { id: string; name: string }[];
  baseline: { date: string; label: string };
  tiles: {
    sales: { count: number; baseline: number };
    gross: { cents: number; baseline: number };
    tax: { cents: number; ratePct: number | null };
    refunds: { cents: number; count: number; baseline: number };
    net: { cents: number; baseline: number };
    orderMoney: { cents: number; orderCount: number };
  };
  tenders: { method: string; count: number; amountCents: number }[];
  refundLine: { count: number; amountCents: number };
  drawers: CloseOutDrawer[];
  close: {
    id: string;
    ranAt: string;
    trigger: string;
    exceptionCount: number;
    stockReleasedCount: number;
  } | null;
  closeHour: number;
  did: { tone: 'ok' | 'risk' | 'hold' | 'info'; text: string }[];
  exceptions: { open: number; total: number };
  events: {
    kind: 'refund' | 'cancellation';
    number: string;
    href: string | null;
    who: string | null;
    note: string;
    amountCents: number;
    at: string;
  }[];
  signoff: { name: string; at: string; openExceptionCount: number; note: string | null } | null;
  viewer: { canSignOff: boolean };
}

const GLYPH = { ok: '✓', risk: '▲', hold: '◔', info: '·' } as const;

function longDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}
function midDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function hourLabel(h: number): string {
  const d = new Date(Date.UTC(2000, 0, 1, h));
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}
function firstName(name: string | null): string {
  if (!name) return '—';
  const [first, ...rest] = name.split(' ');
  return rest.length ? `${first} ${rest[rest.length - 1]![0]}.` : first!;
}
function signed(cents: number): string {
  return cents < 0 ? `−${usdCents(-cents)}` : usdCents(cents);
}

export default function CloseOutSheet({
  date,
  locationId,
  onNavigate,
}: {
  date: string;
  locationId: string | null;
  /** Called with the next date / store the viewer picked. */
  onNavigate: (next: { date: string; locationId: string | null }) => void;
}) {
  const [data, setData] = useState<CloseOutReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<CloseOutDrawer | null>(null);
  const [signing, setSigning] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ date });
    if (locationId) qs.set('locationId', locationId);
    return api<CloseOutReport>(`/v1/closeouts/report?${qs.toString()}`)
      .then(setData)
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'The close-out could not be loaded.'),
      )
      .finally(() => setLoading(false));
  }, [date, locationId]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, fn: () => Promise<CloseOutReport>) => {
    setBusy(key);
    setError(null);
    try {
      setData(await fn());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not go through.');
    } finally {
      setBusy(null);
    }
  };

  if (!data && loading) {
    return (
      <div className="zr" data-testid="close-out-sheet">
        <section className="panel">
          <ShimmerRows rows={6} />
        </section>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="zr" data-testid="close-out-sheet">
        <Alert
          tone="error"
          action={
            <Button size="sm" onClick={() => void load()}>
              Retry
            </Button>
          }
        >
          {error ?? 'The close-out could not be loaded.'}
        </Alert>
      </div>
    );
  }

  const tz = data.location.timezone;
  const t = data.tiles;
  const isToday = data.date >= data.today;
  const closeChip = data.close
    ? {
        status: (data.exceptions.open > 0 ? 'waiting' : 'fulfilled') as 'waiting' | 'fulfilled',
        label: `${data.close.trigger === 'manual' ? 'Closed manually' : 'Auto-closed'} ${clockTime(
          data.close.ranAt,
          tz,
        )} · ${plural(data.close.exceptionCount, 'exception')}`,
      }
    : isToday
      ? { status: 'scheduled' as const, label: `Closes at ${hourLabel(data.closeHour)}` }
      : { status: 'risk' as const, label: 'Close never ran' };
  const netDelta = pctDelta(t.net.cents, t.net.baseline);
  const flagged = data.drawers.filter(
    (d) => (d.status === 'short' || d.status === 'over' || d.status === 'suspended') && !d.reason,
  );

  return (
    <div className="zr" data-testid="close-out-sheet">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="zr-head">
        <div style={{ minWidth: 0 }}>
          <div className="zr-eyebrow t-mono-sm">
            MONEY ·{' '}
            {data.locations.length > 1 ? (
              <select
                className="zr-store"
                value={data.location.id}
                onChange={(e) => onNavigate({ date: data.date, locationId: e.target.value })}
                aria-label="Store"
                data-testid="zr-store"
                data-noprint="true"
              >
                {data.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name.toUpperCase()}
                  </option>
                ))}
              </select>
            ) : (
              data.location.name.toUpperCase()
            )}
          </div>
          <div className="zr-title-row">
            <h1 className="zr-title" data-testid="zr-title">
              Close-out — {longDate(data.date)}
            </h1>
            <StatusChip status={closeChip.status} label={closeChip.label} data-testid="zr-chip" />
          </div>
        </div>
        <div className="zr-nav" data-noprint="true">
          <Button
            size="sm"
            aria-label="Previous day"
            onClick={() =>
              onNavigate({ date: shiftDay(data.date, -1), locationId: data.location.id })
            }
            data-testid="zr-prev"
          >
            ‹
          </Button>
          <label className="zr-date">
            <span className="mono">{midDate(data.date)}</span>
            <input
              type="date"
              value={data.date}
              max={data.today}
              onChange={(e) =>
                e.target.value && onNavigate({ date: e.target.value, locationId: data.location.id })
              }
              aria-label="Close-out date"
              data-testid="zr-date"
            />
          </label>
          <Button
            size="sm"
            aria-label="Next day"
            disabled={isToday}
            onClick={() =>
              onNavigate({ date: shiftDay(data.date, 1), locationId: data.location.id })
            }
            data-testid="zr-next"
          >
            ›
          </Button>
        </div>
      </div>

      {error && (
        <Alert tone="error" data-testid="zr-error">
          {error}
        </Alert>
      )}

      {/* ── Six tiles ──────────────────────────────────────────────── */}
      <div className="wh-figs zr-tiles" data-testid="zr-tiles">
        <Tile
          label="Sales"
          value={String(t.sales.count)}
          sub={`${data.baseline.label} ${t.sales.baseline}`}
          testid="zr-tile-sales"
        />
        <Tile
          label="Gross"
          value={usdCents(t.gross.cents)}
          sub={`${data.baseline.label} ${usdCents(t.gross.baseline)}`}
          testid="zr-tile-gross"
        />
        <Tile
          label="Tax"
          value={usdCents(t.tax.cents)}
          sub={t.tax.ratePct != null ? `${t.tax.ratePct}%` : 'no taxable sales'}
          testid="zr-tile-tax"
        />
        <Tile
          label="Refunds"
          value={usdCents(t.refunds.cents)}
          color={t.refunds.cents > 0 ? 'var(--status-risk-fg)' : undefined}
          sub={`${plural(t.refunds.count, 'refund')} · ${data.baseline.label} ${usdCents(
            t.refunds.baseline,
          )}`}
          testid="zr-tile-refunds"
        />
        <Tile
          label="Net"
          value={signed(t.net.cents)}
          color="var(--accent)"
          sub={
            netDelta
              ? `${netDelta} vs ${data.baseline.label}`
              : `${data.baseline.label} ${usdCents(t.net.baseline)}`
          }
          testid="zr-tile-net"
        />
        <Tile
          label="Order money"
          value={usdCents(t.orderMoney.cents)}
          sub={
            t.orderMoney.orderCount > 0
              ? `deposits on ${plural(t.orderMoney.orderCount, 'order')}`
              : 'no order payments'
          }
          testid="zr-tile-order-money"
        />
      </div>

      {/* ── Three columns ──────────────────────────────────────────── */}
      <div className="zr-grid">
        {/* Tenders */}
        <Panel title="Tenders" clip testid="zr-tenders">
          <table className="dt">
            <thead>
              <tr>
                <th className="first">Method</th>
                <th className="num">Count</th>
                <th className="num last">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.tenders.length === 0 && (
                <tr>
                  <td colSpan={3} className="sub" style={{ padding: '18px var(--pad)' }}>
                    No money taken in.
                  </td>
                </tr>
              )}
              {data.tenders.map((r) => (
                <tr key={r.method} data-testid="zr-tender">
                  <td className="first">
                    <span
                      className="zr-swatch"
                      style={{ background: tenderMeta(r.method).swatch }}
                    />
                    {tenderMeta(r.method).label}
                  </td>
                  <td className="num mono">{r.count}</td>
                  <td className="num mono last">{usdCents(r.amountCents)}</td>
                </tr>
              ))}
              {data.refundLine.count > 0 && (
                <tr className="zr-refund-line" data-testid="zr-refund-line">
                  <td className="first">Refunds</td>
                  <td className="num mono">{data.refundLine.count}</td>
                  <td className="num mono last">−{usdCents(data.refundLine.amountCents)}</td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="zr-note">
            Tender rows are money taken in; refunds are not attributed to a tender — reconcile the
            drawer against the refund line.
          </div>
        </Panel>

        {/* Cash drawers */}
        <Panel title="Cash drawers" sub="blind count at close" clip testid="zr-drawers">
          <div className="zr-scroll">
            <table className="dt zr-drawer-table">
              <thead>
                <tr>
                  <th className="first">Drawer</th>
                  <th className="zr-os">
                    Open →<br />
                    close
                  </th>
                  <th className="num">Expected</th>
                  <th className="num">Counted</th>
                  <th className="num last zr-os">
                    Over /<br />
                    short
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.drawers.length === 0 && (
                  <tr>
                    <td colSpan={5} className="sub" style={{ padding: '18px var(--pad)' }}>
                      No drawer was opened.
                    </td>
                  </tr>
                )}
                {data.drawers.map((d) => (
                  <tr key={d.id} data-testid="zr-drawer" data-status={d.status}>
                    <td className="first">
                      <Link
                        href={`/shifts/${d.id}`}
                        className="panel-link"
                        style={{ fontWeight: 600 }}
                      >
                        Drawer {d.number}
                      </Link>
                      <div className="sub">{firstName(d.closedBy ?? d.openedBy)}</div>
                    </td>
                    <td className="mono zr-time">
                      {clockTime(d.openedAt, tz)} →
                      <br />
                      {d.closedAt ? clockTime(d.closedAt, tz) : 'still open'}
                    </td>
                    <td className="num mono">
                      {d.expectedCashCents != null ? usdCents(d.expectedCashCents) : '—'}
                    </td>
                    <td className="num mono">
                      {d.countedCashCents != null ? usdCents(d.countedCashCents) : '—'}
                    </td>
                    <td
                      className="num mono last"
                      style={{
                        fontWeight: 700,
                        color:
                          d.status === 'short' || d.status === 'suspended'
                            ? 'var(--status-risk-fg)'
                            : d.status === 'over'
                              ? 'var(--status-waiting-fg)'
                              : d.status === 'clean'
                                ? 'var(--status-fulfilled-fg)'
                                : 'var(--muted)',
                      }}
                    >
                      {d.status === 'open'
                        ? 'open'
                        : d.status === 'clean'
                          ? '$0.00'
                          : signed(d.varianceCents ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.drawers
            .filter((d) => d.reason)
            .map((d) => (
              <div className="zr-reason" key={d.id} data-testid="zr-reason">
                <strong>Drawer {d.number}</strong> · {d.reason!.text}{' '}
                <span className="sub">
                  — {d.reason!.by}, {clockTime(d.reason!.at, tz)}
                </span>
              </div>
            ))}

          {flagged.map((d) => {
            const amt = usdCents(Math.abs(d.varianceCents ?? 0));
            const word = d.status === 'over' ? 'over' : 'short';
            return (
              <div className="zr-exception" key={d.id} data-testid="zr-exception">
                <div className="zr-exception-glyph" aria-hidden>
                  ▲
                </div>
                <div style={{ minWidth: 0 }}>
                  <p>
                    <strong>
                      Drawer {d.number} is {word} {amt}.
                    </strong>{' '}
                    {d.closedBy ?? 'The cashier'} closed at{' '}
                    {d.closedAt ? clockTime(d.closedAt, tz) : '—'}
                    {d.status === 'suspended' ? ' after the drawer was suspended' : ''}
                    {d.recount
                      ? `; ${d.recount.by} asked for a recount at ${clockTime(d.recount.at, tz)}.`
                      : ' without a recount.'}{' '}
                    {d.recount
                      ? 'Record the variance with a reason once the recount is in; it goes to the owner’s exceptions either way.'
                      : 'Ask for a recount or record the variance with a reason; either way it goes to the owner’s exceptions.'}
                  </p>
                  {data.viewer.canSignOff && (
                    <div className="zr-exception-actions" data-noprint="true">
                      {!d.recount && (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={busy != null}
                          onClick={() =>
                            void act(`recount:${d.id}`, () =>
                              api<CloseOutReport>(`/v1/closeouts/drawers/${d.id}/recount`, {
                                method: 'POST',
                              }),
                            )
                          }
                          data-testid="zr-recount"
                        >
                          {busy === `recount:${d.id}` ? 'Requesting…' : 'Request recount'}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        disabled={busy != null}
                        onClick={() => setReasonFor(d)}
                        data-testid="zr-reason-open"
                      >
                        Record with reason
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </Panel>

        {/* Right column */}
        <div className="zr-side">
          <Panel title="What the 10pm close did" clip testid="zr-did">
            <ul className="dh-list zr-did">
              {data.did.map((l, i) => (
                <li
                  key={i}
                  className={
                    l.tone === 'ok'
                      ? 'is-ok'
                      : l.tone === 'risk'
                        ? 'is-risk'
                        : l.tone === 'hold'
                          ? 'is-warn'
                          : ''
                  }
                >
                  <span className="dh-list-glyph">{GLYPH[l.tone]}</span>
                  <span>{l.text}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Refunds & cancellations" clip testid="zr-events">
            {data.events.length === 0 ? (
              <div className="zr-note" style={{ borderTop: 0 }}>
                No refunds or cancellations.
              </div>
            ) : (
              <ul className="zr-events">
                {data.events.map((e, i) => (
                  <li key={i} data-testid="zr-event" data-kind={e.kind}>
                    <span style={{ minWidth: 0 }}>
                      {e.href ? (
                        <Link href={e.href} className="mono panel-link">
                          {e.number}
                        </Link>
                      ) : (
                        <span className="mono">{e.number}</span>
                      )}
                      {e.who ? <span className="sub"> · {firstName(e.who)}</span> : null}
                      <span className="sub"> · {e.note}</span>
                    </span>
                    <span
                      className="mono"
                      style={{
                        color:
                          e.kind === 'refund'
                            ? 'var(--status-risk-fg)'
                            : 'var(--status-waiting-fg)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {e.kind === 'refund'
                        ? `−${usdCents(Math.abs(e.amountCents))}`
                        : e.amountCents > 0
                          ? `${usdCents(e.amountCents)} paid`
                          : 'cancelled'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {data.signoff ? (
            <div className="zr-signed" data-testid="zr-signed">
              <StatusChip status="fulfilled" label="Signed off" />
              <div>
                <strong>{data.signoff.name}</strong> · {clockTime(data.signoff.at, tz)}
                {data.signoff.openExceptionCount > 0 && (
                  <span className="sub">
                    {' '}
                    · {plural(data.signoff.openExceptionCount, 'exception')} still open when signed
                  </span>
                )}
                {data.signoff.note && <div className="sub">“{data.signoff.note}”</div>}
              </div>
            </div>
          ) : (
            <div data-noprint="true">
              <Button
                variant="primary"
                className="zr-sign"
                disabled={!data.viewer.canSignOff || busy != null}
                onClick={() => setSigning(true)}
                data-testid="zr-sign"
                title={
                  data.viewer.canSignOff
                    ? undefined
                    : 'Signing needs the close-out sign-off permission'
                }
              >
                Sign off close-out
              </Button>
              <div className="zr-sign-copy">
                Signing records your name and time; the exception stays open until resolved.
              </div>
            </div>
          )}
        </div>
      </div>

      {reasonFor && (
        <ReasonDialog
          drawer={reasonFor}
          tz={tz}
          busy={busy === `reason:${reasonFor.id}`}
          onClose={() => setReasonFor(null)}
          onSave={(reason) =>
            act(`reason:${reasonFor.id}`, () =>
              api<CloseOutReport>(`/v1/closeouts/drawers/${reasonFor.id}/reason`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason }),
              }),
            ).then(() => setReasonFor(null))
          }
        />
      )}

      {signing && (
        <SignDialog
          report={data}
          busy={busy === 'sign'}
          onClose={() => setSigning(false)}
          onSign={(note) =>
            act('sign', () =>
              api<CloseOutReport>('/v1/closeouts/sign-off', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ locationId: data.location.id, date: data.date, note }),
              }),
            ).then(() => setSigning(false))
          }
        />
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  color,
  testid,
}: {
  label: string;
  value: string;
  sub: string;
  color?: string;
  testid: string;
}) {
  return (
    <div className="wh-fig" data-testid={testid}>
      <div className="wh-fig-label t-mono-sm" style={{ textTransform: 'uppercase' }}>
        {label}
      </div>
      <div className="wh-fig-row">
        <span className="wh-fig-value mono" style={{ color }}>
          {value}
        </span>
      </div>
      <div className="wh-fig-sub">{sub}</div>
    </div>
  );
}

function ReasonDialog({
  drawer,
  tz,
  busy,
  onClose,
  onSave,
}: {
  drawer: CloseOutDrawer;
  tz: string;
  busy: boolean;
  onClose: () => void;
  onSave: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const amt = usdCents(Math.abs(drawer.varianceCents ?? 0));
  return (
    <Dialog
      title={`Record Drawer ${drawer.number} ${drawer.status === 'over' ? 'over' : 'short'} ${amt}`}
      description={`Closed by ${drawer.closedBy ?? 'the cashier'} at ${
        drawer.closedAt ? clockTime(drawer.closedAt, tz) : '—'
      }. The reason goes on the owner's exceptions with your name; the drawer's numbers do not change.`}
      onClose={onClose}
      size="sm"
      initialFocus={ref}
      testId="zr-reason-dialog"
      foot={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || reason.trim().length < 3}
            onClick={() => onSave(reason.trim())}
            data-testid="zr-reason-save"
          >
            {busy ? 'Recording…' : 'Record reason'}
          </Button>
        </>
      }
    >
      <Field
        label="Reason"
        hint="e.g. Change fund short — $80 float borrowed for the register 2 opening"
      >
        <textarea
          ref={ref}
          className="input"
          rows={3}
          maxLength={240}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="zr-reason-text"
        />
      </Field>
    </Dialog>
  );
}

function SignDialog({
  report,
  busy,
  onClose,
  onSign,
}: {
  report: CloseOutReport;
  busy: boolean;
  onClose: () => void;
  onSign: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  const open = report.exceptions.open;
  return (
    <Dialog
      title={`Sign off ${longDate(report.date)}`}
      description={
        open > 0
          ? `${plural(open, 'exception')} from this close stay open on the register after you sign — signing says you read the sheet, not that they are resolved.`
          : 'Signing records your name and the time on this sheet.'
      }
      onClose={onClose}
      size="sm"
      testId="zr-sign-dialog"
      foot={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => onSign(note.trim())}
            data-testid="zr-sign-confirm"
          >
            {busy ? 'Signing…' : 'Sign off close-out'}
          </Button>
        </>
      }
    >
      <div className="zr-sign-summary mono">
        <span>Net {signed(report.tiles.net.cents)}</span>
        <span>{plural(report.drawers.length, 'drawer')}</span>
        <span>{plural(open, 'open exception')}</span>
      </div>
      <Field label="Note (optional)">
        <input
          className="input"
          maxLength={200}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Anything the owner should know about tonight"
          data-testid="zr-sign-note"
        />
      </Field>
    </Dialog>
  );
}
