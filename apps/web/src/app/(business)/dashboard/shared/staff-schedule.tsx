'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { Panel, ShimmerRows } from '../owner/owner-kit';
import {
  dowDate,
  hours1,
  localToday,
  mondayOf,
  readLocal,
  shiftCompact,
  shiftLabel,
  weekLabel,
  writeLocal,
} from './kit';
import { ShiftEditorDialog } from './shift-editor-dialog';
import type { ScheduleWeek, SchedulePerson } from './types';

/**
 * Screen 5 — the staff schedule card (hand-off 2026-09-10, step 2): one
 * week, Monday → Sunday, every person in scope with a cell per day. Owner
 * and Operations click a cell to set a shift and publish the week; Manager
 * and Warehouse read it, locked to their own location.
 */
const WEEK_KEY = 'jetnine.dashboard.schedWeek';
const STORE_KEY = 'jetnine.dashboard.schedStore';

interface EditCell {
  person: SchedulePerson;
  date: string;
  dow: string;
  start: number | null;
  end: number | null;
}

export function StaffSchedule({
  lockedLocationId = null,
  readOnly = false,
  handle,
  style,
}: {
  /** Manager / Warehouse: the grid is pinned to this location and the picker hides. */
  lockedLocationId?: string | null;
  /** Manager / Warehouse: never editable, whatever the member's permissions. */
  readOnly?: boolean;
  handle?: ReactNode;
  style?: React.CSSProperties;
}) {
  const [weekOffset, setWeekOffsetState] = useState(0);
  const [store, setStoreState] = useState<string>('');
  const [data, setData] = useState<ScheduleWeek | null | undefined>(undefined);
  const [edit, setEdit] = useState<EditCell | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const w = readLocal<number>(WEEK_KEY, 0);
    setWeekOffsetState(Number.isInteger(w) ? Math.max(-52, Math.min(52, w)) : 0);
    if (!lockedLocationId) setStoreState(readLocal<string>(STORE_KEY, ''));
  }, [lockedLocationId]);
  const setWeekOffset = (n: number) => {
    setWeekOffsetState(n);
    writeLocal(WEEK_KEY, n);
  };
  const setStore = (id: string) => {
    setStoreState(id);
    writeLocal(STORE_KEY, id);
  };

  const locationId = lockedLocationId ?? (store || null);
  const load = useCallback(() => {
    const qs = new URLSearchParams({ week: mondayOf(localToday(), weekOffset) });
    if (locationId) qs.set('locationId', locationId);
    return api<ScheduleWeek>(`/v1/schedule?${qs.toString()}`)
      .then(setData)
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 403) setData(null);
        else setData((d) => d ?? null);
      });
  }, [weekOffset, locationId]);
  useEffect(() => {
    void load();
  }, [load]);

  const canEdit = !!data?.canEdit && !readOnly;

  const stats = useMemo(() => {
    const people = data?.people ?? [];
    let shifts = 0;
    let minutes = 0;
    const covered = new Set<string>();
    const perPerson = new Map<string, number>();
    for (const p of people) {
      let mine = 0;
      for (const s of p.shifts) {
        if (s.startMinutes == null || s.endMinutes == null) continue;
        shifts += 1;
        mine += s.endMinutes - s.startMinutes;
        covered.add(s.date);
      }
      minutes += mine;
      perPerson.set(p.membershipId, mine / 60);
    }
    const uncovered = (data?.week.days ?? []).filter((d) => !covered.has(d.date));
    return { people: people.length, shifts, hours: minutes / 60, uncovered, perPerson };
  }, [data]);

  const save = async (start: number, end: number) => {
    if (!edit) return;
    setBusy(true);
    try {
      await api('/v1/schedule/shifts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          membershipId: edit.person.membershipId,
          date: edit.date,
          startMinutes: start,
          endMinutes: end,
          locationId: locationId ?? edit.person.locationId ?? undefined,
        }),
      });
      toast.success(
        `${edit.person.name} · ${dowDate(edit.dow, edit.date)} · ${shiftLabel(start, end)}`,
      );
      setEdit(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const dayOff = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      await api('/v1/schedule/shifts/off', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ membershipId: edit.person.membershipId, date: edit.date }),
      });
      toast(`${edit.person.name} · ${dowDate(edit.dow, edit.date)} · day off`);
      setEdit(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!data) return;
    setBusy(true);
    try {
      await api('/v1/schedule/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ week: data.week.start, locationId: locationId ?? undefined }),
      });
      toast.success(`Schedule published for ${weekLabel(data.week.start, data.week.end)}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (data === null) return null;

  const weekSub = data
    ? `${weekLabel(data.week.start, data.week.end)}${
        weekOffset === 0
          ? ' · this week'
          : weekOffset === 1
            ? ' · next week'
            : weekOffset === -1
              ? ' · last week'
              : ''
      }`
    : '…';

  return (
    <Panel
      title="Staff schedule"
      sub={weekSub}
      style={style}
      testid="staff-schedule"
      actions={
        <>
          <div style={{ display: 'inline-flex', gap: 4 }} data-noprint="true">
            <button
              type="button"
              className="sched-nav"
              onClick={() => setWeekOffset(weekOffset - 1)}
              aria-label="Previous week"
              data-testid="sched-prev"
            >
              ←
            </button>
            <button
              type="button"
              className="sched-nav"
              onClick={() => setWeekOffset(weekOffset + 1)}
              aria-label="Next week"
              data-testid="sched-next"
            >
              →
            </button>
            <button
              type="button"
              className="sched-nav is-wide"
              onClick={() => setWeekOffset(0)}
              data-testid="sched-this-week"
            >
              This week
            </button>
          </div>
          {!lockedLocationId && data && (
            <select
              className="select select-sm"
              value={store}
              onChange={(e) => setStore(e.target.value)}
              aria-label="Location"
              data-testid="sched-location"
              data-noprint="true"
            >
              <option value="">All locations</option>
              {data.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.locationType === 'warehouse' ? ' (DC)' : ''}
                </option>
              ))}
            </select>
          )}
          <span
            style={{
              marginLeft: 'auto',
              padding: '2px 8px',
              borderRadius: 4,
              fontSize: 11.5,
              background: canEdit ? 'var(--accent-soft)' : 'var(--surface2)',
              color: canEdit ? 'var(--accent-ink)' : 'var(--muted)',
              whiteSpace: 'nowrap',
            }}
            data-testid="sched-permission"
          >
            {canEdit
              ? 'You can edit · click a shift'
              : 'View only · Operations and the owner edit shifts'}
          </span>
          {handle}
        </>
      }
    >
      {data === undefined ? (
        <ShimmerRows rows={4} />
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table className="sched-table" data-testid="sched-grid">
              <thead>
                <tr>
                  <th>Staff</th>
                  {data.week.days.map((d) => (
                    <th key={d.date} className={d.isToday ? 'is-today' : undefined}>
                      {d.dow}
                      <span className="date">{d.date.slice(5).replace('-', '/')}</span>
                    </th>
                  ))}
                  <th style={{ textAlign: 'right', paddingRight: 'var(--pad)' }}>Hrs</th>
                </tr>
              </thead>
              <tbody>
                {data.people.length === 0 && (
                  <tr>
                    <td
                      colSpan={9}
                      style={{
                        padding: '24px var(--pad)',
                        textAlign: 'center',
                        color: 'var(--muted)',
                      }}
                    >
                      Nobody is set up at this location yet.
                    </td>
                  </tr>
                )}
                {data.people.map((p) => {
                  const h = stats.perPerson.get(p.membershipId) ?? 0;
                  return (
                    <tr key={p.membershipId} data-testid="sched-row">
                      <td>
                        <div style={{ fontWeight: p.isLead ? 600 : 400 }}>{p.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                          {p.roleName ?? 'Member'} · {p.locationName}
                        </div>
                      </td>
                      {data.week.days.map((d) => {
                        const s = p.shifts.find((x) => x.date === d.date);
                        const hasShift = !!s && s.startMinutes != null && s.endMinutes != null;
                        const pending = !!s && s.startMinutes == null;
                        return (
                          <td key={d.date} className={d.isToday ? 'is-today' : undefined}>
                            <button
                              type="button"
                              className={`sched-cell${hasShift ? ' is-shift' : pending ? ' is-pending' : ' is-off'}`}
                              disabled={!canEdit}
                              onClick={() =>
                                canEdit &&
                                setEdit({
                                  person: p,
                                  date: d.date,
                                  dow: d.dow,
                                  start: hasShift ? s!.startMinutes : null,
                                  end: hasShift ? s!.endMinutes : null,
                                })
                              }
                              title={
                                hasShift
                                  ? `${shiftLabel(s!.startMinutes!, s!.endMinutes!)}${s!.published ? '' : ' · unpublished'}`
                                  : pending
                                    ? 'Day off · unpublished'
                                    : 'Day off'
                              }
                              data-testid="sched-cell"
                            >
                              {hasShift ? shiftCompact(s!.startMinutes!, s!.endMinutes!) : 'off'}
                            </button>
                          </td>
                        );
                      })}
                      <td
                        className="mono"
                        style={{
                          textAlign: 'right',
                          paddingRight: 'var(--pad)',
                          color: h > 40 ? 'var(--warn)' : 'var(--text2)',
                        }}
                      >
                        {h > 0 ? hours1(h) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div
            className="panel-foot"
            style={{ fontSize: 12.5, flexWrap: 'wrap' }}
            data-testid="sched-footer"
          >
            <span style={{ color: 'var(--muted)' }}>
              {stats.people} {stats.people === 1 ? 'person' : 'people'} · {stats.shifts}{' '}
              {stats.shifts === 1 ? 'shift' : 'shifts'} · {hours1(stats.hours)} scheduled hours
            </span>
            <span
              style={{ color: stats.uncovered.length === 0 ? 'var(--accent-ink)' : 'var(--warn)' }}
            >
              {stats.uncovered.length === 0
                ? 'Every day covered'
                : `${stats.uncovered.length} day${stats.uncovered.length === 1 ? '' : 's'} with no coverage: ${stats.uncovered.map((d) => d.dow).join(', ')}`}
            </span>
            {canEdit && (
              <span
                style={{
                  marginLeft: 'auto',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <span style={{ color: data.unpublishedCount > 0 ? 'var(--warn)' : 'var(--muted)' }}>
                  {data.unpublishedCount > 0
                    ? `${data.unpublishedCount} unpublished change${data.unpublishedCount === 1 ? '' : 's'}`
                    : 'Published'}
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy || data.unpublishedCount === 0}
                  onClick={() => void publish()}
                  data-testid="sched-publish"
                >
                  Publish week
                </button>
              </span>
            )}
          </div>
        </>
      )}
      {edit && (
        <ShiftEditorDialog
          name={edit.person.name}
          dayLabel={dowDate(edit.dow, edit.date)}
          start={edit.start}
          end={edit.end}
          busy={busy}
          onSave={(s, e) => void save(s, e)}
          onDayOff={() => void dayOff()}
          onClose={() => setEdit(null)}
        />
      )}
    </Panel>
  );
}
