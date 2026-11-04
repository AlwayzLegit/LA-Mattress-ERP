'use client';

import Link from 'next/link';
import { Download } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { downloadFile } from '@/lib/download';
import { DateRangePicker, useUrlDateRange } from '@/components/date-range-picker';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  LoadingRows,
  PageHeader,
  Select,
  Stack,
  StatGrid,
  StatTile,
  TableWrap,
  Toolbar,
} from '@/components/ui';

/**
 * Report Time Clock Activity (STORIS, owner 2026-11-04): each member's
 * punches and hours between two dates, a row per store-local day, with
 * a total per person and for the range.
 */

type PunchType = 'clock_in' | 'break_start' | 'break_end' | 'clock_out';

interface Day {
  date: string;
  firstIn: string | null;
  lastOut: string | null;
  breakMinutes: number;
  hours: number;
  openAtEnd: boolean;
  punches: { type: PunchType; at: string; locationName: string | null }[];
}
interface Person {
  membershipId: string;
  name: string;
  roleName: string | null;
  locationName: string;
  days: Day[];
  daysWorked: number;
  totalHours: number;
}
interface Report {
  generatedAt: string;
  range: { start: string; end: string };
  timezone: string;
  people: Person[];
  totals: { people: number; daysWorked: number; hours: number };
}
interface Member {
  membershipId: string;
  name: string | null;
  email: string;
  status: string;
}
interface Location {
  id: string;
  name: string;
  isActive: boolean;
}

const PUNCH_LABEL: Record<PunchType, string> = {
  clock_in: 'In',
  break_start: 'Break',
  break_end: 'Back',
  clock_out: 'Out',
};

function fmtDate(d: string): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, day).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/** "2026-11-04T09:05" → "9:05 AM" */
function fmtTime(local: string | null): string {
  if (!local) return '';
  const [h, m] = local.slice(11).split(':').map(Number) as [number, number];
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ampm}`;
}

function fmtHours(h: number): string {
  return h.toFixed(2);
}

export default function TimeClockActivityPage() {
  const [range, setRange, rangeReady] = useUrlDateRange('wtd');
  const [membershipId, setMembershipId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [showPunches, setShowPunches] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Member[]>('/v1/business/members')
      .then((rows) => setMembers(rows))
      .catch(() => setMembers([]));
    api<Location[]>('/v1/business/locations')
      .then((rows) => setLocations(rows.filter((l) => l.isActive)))
      .catch(() => setLocations([]));
  }, []);

  function query(): string {
    const p = new URLSearchParams({ start: range.start, end: range.end });
    if (membershipId) p.set('membershipId', membershipId);
    if (locationId) p.set('locationId', locationId);
    return p.toString();
  }

  useEffect(() => {
    if (!rangeReady) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    api<Report>(`/v1/timeclock/activity?${query()}`)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeReady, range.start, range.end, membershipId, locationId]);

  async function exportCsv() {
    setExporting(true);
    try {
      await downloadFile(
        `/v1/timeclock/activity?${query()}&format=csv`,
        `time-clock-activity-${range.start}-to-${range.end}.csv`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div data-testid="time-clock-activity">
      <p style={{ margin: '0 0 12px' }}>
        <Link href="/reports">← Reports</Link>
      </p>
      <PageHeader
        title="Report Time Clock Activity"
        sub="Every punch and the hours it adds up to, a row per day for each member, between the dates you pick."
        actions={
          <Button
            variant="secondary"
            onClick={() => void exportCsv()}
            disabled={exporting || !report}
            data-testid="tca-export"
          >
            <Download size={14} />
            {exporting ? 'Exporting…' : 'Export CSV'}
          </Button>
        }
      />

      <Stack>
        <Card>
          <Toolbar className="items-end">
            <Field label="Dates" as="div">
              <DateRangePicker value={range} onChange={setRange} compact testid="tca-range" />
            </Field>
            <Field label="Member">
              <Select
                value={membershipId}
                onChange={(e) => setMembershipId(e.target.value)}
                data-testid="tca-member"
              >
                <option value="">Everyone</option>
                {members.map((m) => (
                  <option key={m.membershipId} value={m.membershipId}>
                    {m.name ?? m.email}
                    {m.status !== 'active' ? ` (${m.status})` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Store">
              <Select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                data-testid="tca-location"
              >
                <option value="">All stores</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Detail" as="div">
              <label className="flex items-center gap-2" style={{ minHeight: 36 }}>
                <input
                  type="checkbox"
                  checked={showPunches}
                  onChange={(e) => setShowPunches(e.target.checked)}
                  data-testid="tca-show-punches"
                />
                Show every punch
              </label>
            </Field>
          </Toolbar>
        </Card>

        {error && <Alert tone="error">{error}</Alert>}

        {report && (
          <StatGrid>
            <StatTile
              label="Hours"
              value={fmtHours(report.totals.hours)}
              sub={`${fmtDate(report.range.start)}${
                report.range.end !== report.range.start ? ` – ${fmtDate(report.range.end)}` : ''
              }`}
            />
            <StatTile label="People" value={String(report.totals.people)} sub="with punches" />
            <StatTile
              label="Days worked"
              value={String(report.totals.daysWorked)}
              sub="across everyone"
            />
          </StatGrid>
        )}

        {busy && !report ? (
          <Card>
            <LoadingRows rows={5} />
          </Card>
        ) : !report || report.people.length === 0 ? (
          <Card>
            <EmptyState title="No punches in this range">
              Hours come from the time clock on the dashboard and the kiosk.
            </EmptyState>
          </Card>
        ) : (
          report.people.map((p) => (
            <Card
              key={p.membershipId}
              title={p.name}
              description={`${[p.roleName, p.locationName].filter(Boolean).join(' · ')} · ${p.daysWorked} day${
                p.daysWorked === 1 ? '' : 's'
              } · ${fmtHours(p.totalHours)} h`}
              flush
              data-testid="tca-person"
            >
              <TableWrap>
                <table className="table table-dense">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>In</th>
                      <th>Out</th>
                      <th className="num">Break</th>
                      <th className="num">Hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.days.map((d) => (
                      <Fragment key={d.date}>
                        <tr data-testid="tca-day">
                          <td>{fmtDate(d.date)}</td>
                          <td>
                            {d.firstIn ? (
                              fmtTime(d.firstIn)
                            ) : (
                              <span className="muted" title="The shift began the day before">
                                carried in
                              </span>
                            )}
                          </td>
                          <td>
                            {d.lastOut ? (
                              fmtTime(d.lastOut)
                            ) : d.openAtEnd ? (
                              <span className="muted">on the clock</span>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td className="num">
                            {d.breakMinutes > 0 ? `${d.breakMinutes} min` : '—'}
                          </td>
                          <td className="num">
                            <strong>{fmtHours(d.hours)}</strong>
                          </td>
                        </tr>
                        {showPunches && d.punches.length > 0 && (
                          <tr className="muted" data-testid="tca-punches">
                            <td />
                            <td colSpan={4} className="text-xs">
                              {d.punches
                                .map(
                                  (x) =>
                                    `${PUNCH_LABEL[x.type]} ${fmtTime(x.at)}${
                                      x.locationName ? ` @ ${x.locationName}` : ''
                                    }`,
                                )
                                .join(' · ')}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4}>
                        <strong>Total</strong>
                      </td>
                      <td className="num">
                        <strong>{fmtHours(p.totalHours)}</strong>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </TableWrap>
            </Card>
          ))
        )}

        {report && report.people.length > 0 && (
          <Card title="Grand total" data-testid="tca-grand">
            {report.totals.people} {report.totals.people === 1 ? 'person' : 'people'} ·{' '}
            {report.totals.daysWorked} days worked ·{' '}
            <strong>{fmtHours(report.totals.hours)} h</strong>
          </Card>
        )}

        <p className="muted text-xs">
          Hours are the time between clock-in and clock-out with breaks taken out, the same
          arithmetic as the dashboard time clock. A shift that runs past midnight is split at
          midnight on store time, so the first day shows no clock-in and the next day no clock-out.
        </p>
      </Stack>
    </div>
  );
}
