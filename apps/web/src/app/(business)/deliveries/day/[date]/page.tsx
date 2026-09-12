'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { Printer } from 'lucide-react';
import { formatMoney } from '@jetnine/shared';
import { api } from '@/lib/api';
import { useBusinessName } from '@/lib/business-settings';
import { Alert, Button, LinkButton, LoadingRows } from '@/components/ui';

/**
 * Day sheet (redesign Phase 8, README §3.4, canvas 7e): the paper a
 * driver clips in the cab. Letter, black on white, 14pt: stop number
 * at 26pt, customer / phone / address, one tick box per piece, window,
 * what to collect in bold when money is owed, a signature line, the
 * COD total in the header, and the failed-stop instruction on every
 * page. Any over-capacity note the dispatcher wrote when moving a stop
 * onto this day prints under the header.
 */

interface DeliveryRow {
  id: string;
  kind?: 'delivery' | 'return_pickup';
  orderNumber: string;
  rmaNumber?: string | null;
  customerName: string | null;
  scheduledDate: string;
  windowStart: string | null;
  windowEnd: string | null;
  status: string;
  route: string | null;
  routePosition: number | null;
  runId?: string | null;
  notes: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostalCode: string | null;
  addressPhone: string | null;
  balanceDueCents: number;
  lines: { id: string; description: string; quantity: number; lineType?: string }[];
}
interface RunRow {
  id: string;
  route: string | null;
  truck: string | null;
  driverMembershipId: string | null;
  status: string;
  notes: string | null;
}
interface MemberRow {
  membershipId: string;
  name: string | null;
}

function hhmm(t: string | null): string {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hour = Number(h);
  if (!Number.isFinite(hour)) return t;
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${m ?? '00'} ${ampm}`;
}
function longDay(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return Number.isNaN(d.getTime())
    ? date
    : d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}
/** The over-cap notes the reschedule wrote onto deliveries ("Over cap 2026-09-12: …"). */
function capNotes(rows: DeliveryRow[], date: string): string[] {
  const out: string[] = [];
  for (const r of rows) {
    for (const line of (r.notes ?? '').split('\n')) {
      const m = /^Over cap (\d{4}-\d{2}-\d{2}): (.+)$/.exec(line.trim());
      if (m && m[1] === date) out.push(m[2]!);
    }
  }
  return out;
}

export default function DaySheetPage() {
  const params = useParams<{ date: string }>();
  const date = (params?.date ?? '') as string;
  const business = useBusinessName() ?? 'LA Mattress';
  const [rows, setRows] = useState<DeliveryRow[] | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [printedAt] = useState(() => new Date());

  useEffect(() => {
    if (!date) return;
    void api<DeliveryRow[]>(`/v1/deliveries?from=${date}&to=${date}`)
      .then((all) => setRows(all.filter((r) => r.status !== 'cancelled')))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    void api<RunRow[]>(`/v1/delivery-runs?date=${date}`)
      .then((r) => setRuns(Array.isArray(r) ? r : []))
      .catch(() => setRuns([]));
    void api<MemberRow[]>('/v1/business/members')
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [date]);

  const stops = useMemo(
    () =>
      [...(rows ?? [])].sort(
        (a, b) =>
          (a.routePosition ?? 999) - (b.routePosition ?? 999) ||
          (a.windowStart ?? '').localeCompare(b.windowStart ?? ''),
      ),
    [rows],
  );
  const pieces = stops.reduce((n, s) => n + s.lines.reduce((m, l) => m + l.quantity, 0), 0);
  const cod = stops.reduce((n, s) => n + (s.kind === 'return_pickup' ? 0 : s.balanceDueCents), 0);
  const run = runs[0] ?? null;
  const driver = run?.driverMembershipId
    ? (members.find((m) => m.membershipId === run.driverMembershipId)?.name ?? null)
    : null;
  const routeText =
    run?.route ??
    [...new Set(stops.map((s) => s.route ?? s.addressCity).filter(Boolean))].join(' → ');
  const notes = capNotes(stops, date);

  return (
    <div className="ds-wrap" data-testid="day-sheet">
      <div className="ds-toolbar no-print">
        <Link href="/deliveries" className="pp-crumb">
          ← Deliveries
        </Link>
        <span style={{ marginLeft: 'auto' }} />
        <LinkButton
          href={`/print/deliveries?date=${date}`}
          size="sm"
          data-testid="print-all-tickets"
        >
          <Printer size={13} aria-hidden />
          All tickets (no lock)
        </LinkButton>
        <Button
          variant="primary"
          size="sm"
          onClick={() => window.print()}
          data-testid="print-day-sheet"
        >
          <Printer size={14} aria-hidden />
          Print day sheet
        </Button>
      </div>
      {error && <Alert tone="error">{error}</Alert>}

      <article className="ds-page" aria-label={`Day sheet ${date}`}>
        <header className="ds-head">
          <div>
            <div className="ds-eyebrow">
              {business}
              {run?.truck ? ` · ${run.truck}` : ''}
            </div>
            <h1 className="ds-title">Day sheet — {longDay(date)}</h1>
          </div>
          <div className="ds-head-right">
            <div data-testid="ds-count">
              {stops.length} stop{stops.length === 1 ? '' : 's'} · {pieces} piece
              {pieces === 1 ? '' : 's'}
            </div>
            {driver && <div>Driver: {driver}</div>}
            <div>
              Printed{' '}
              {printedAt.toLocaleString('en-US', {
                month: 'numeric',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </div>
          </div>
        </header>
        <div className="ds-meta">
          {run?.status === 'out' && (
            <span>
              <strong>Departed</strong>
            </span>
          )}
          {routeText && (
            <span>
              <strong>Route</strong> {routeText}
            </span>
          )}
          <span>
            <strong>COD to collect</strong>{' '}
            <span className="mono" data-testid="ds-cod">
              {formatMoney(cod)}
            </span>
          </span>
          <span className="ds-meta-right">
            <strong>Dispatch</strong> call the warehouse before leaving a failed stop
          </span>
        </div>
        {notes.length > 0 && (
          <div className="ds-capnote" data-testid="ds-capnote">
            <strong>Over capacity today</strong> — {notes.join(' · ')}
          </div>
        )}

        {!rows && !error && (
          <div style={{ padding: 16 }}>
            <LoadingRows rows={4} height={60} what="The day" />
          </div>
        )}
        {stops.map((s, i) => {
          const pickup = s.kind === 'return_pickup';
          const owed = !pickup && s.balanceDueCents > 0;
          return (
            <section key={s.id} className="ds-stop" data-testid="ds-stop">
              <div className="ds-stop-num">{s.routePosition ?? i + 1}</div>
              <div>
                <div className="ds-stop-line1">
                  <span className="ds-stop-order">
                    {pickup ? (s.rmaNumber ?? s.orderNumber) : s.orderNumber}
                  </span>
                  <span className="ds-stop-cust">{s.customerName ?? '—'}</span>
                  {s.addressPhone && <span className="ds-stop-phone">{s.addressPhone}</span>}
                  {pickup && <span>PICKUP — bring the goods back</span>}
                </div>
                <div className="ds-stop-addr">
                  {[s.addressLine1, s.addressLine2].filter(Boolean).join(', ')}
                  {s.addressCity
                    ? ` — ${[s.addressCity, s.addressRegion, s.addressPostalCode].filter(Boolean).join(', ')}`
                    : ''}
                </div>
                <ul className="ds-pieces">
                  {s.lines.flatMap((l) =>
                    Array.from({ length: Math.max(1, l.quantity) }, (_, k) => (
                      <li key={`${l.id}-${k}`}>
                        <span className="ds-tick" aria-hidden />
                        <span>
                          {l.description}
                          {l.quantity > 1 ? ` (${k + 1} of ${l.quantity})` : ''}
                        </span>
                      </li>
                    )),
                  )}
                </ul>
                {s.notes &&
                  s.notes
                    .split('\n')
                    .filter((n) => n.trim() && !/^Over cap \d{4}-\d{2}-\d{2}:/.test(n.trim()))
                    .map((n, k) => (
                      <div key={k} className="ds-note">
                        {n}
                      </div>
                    ))}
              </div>
              <div className="ds-stop-right">
                <div className="ds-window">
                  {s.windowStart || s.windowEnd
                    ? `${hhmm(s.windowStart)}–${hhmm(s.windowEnd)}`
                    : 'Any time'}
                </div>
                <div className="ds-due-label">
                  {pickup ? 'Return pickup' : owed ? 'Collect at door' : 'Paid in full'}
                </div>
                <div className={`ds-due${owed ? ' is-owed' : ''}`}>
                  {pickup ? '—' : formatMoney(s.balanceDueCents)}
                </div>
                <div className="ds-sig">
                  Signature
                  <div className="ds-sig-line" />
                </div>
              </div>
            </section>
          );
        })}
        {rows && stops.length === 0 && (
          <div className="ds-empty" data-testid="ds-empty">
            No stops on this day.
          </div>
        )}
        <footer className="ds-foot">
          <span>
            Failed stop? Circle the number, write the reason, call dispatch before leaving.
          </span>
          <span>
            {business} · {date}
          </span>
        </footer>
      </article>
    </div>
  );
}
