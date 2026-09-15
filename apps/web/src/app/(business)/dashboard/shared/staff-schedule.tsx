'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { availableStaff, storeRosters } from './schedule-roster';

/**
 * Screen 5 — the staff schedule card (hand-off 2026-09-10, step 2): one
 * week, Monday → Sunday, every store in scope with a roster per day. Owner
 * and Operations click a cell to set a shift and publish the week; Manager
 * and Warehouse read it, locked to their own location.
 */
const WEEK_KEY = 'jetnine.dashboard.schedWeek';
const STORE_KEY = 'jetnine.dashboard.schedStore';

interface EditCell {
  person: SchedulePerson;
  date: string;
  dow: string;
  locationId: string | null;
  locationName: string;
  start: number | null;
  end: number | null;
}

export function StaffSchedule({
  lockedLocationId = null,
  readOnly = false,
  handle,
  style,
  preferenceKey = 'jetnine.dashboard.scheduleDetail',
}: {
  /** Manager / Warehouse: the grid is pinned to this location and the picker hides. */
  lockedLocationId?: string | null;
  /** Manager / Warehouse: never editable, whatever the member's permissions. */
  readOnly?: boolean;
  handle?: ReactNode;
  style?: React.CSSProperties;
  preferenceKey?: string;
}) {
  const [weekOffset, setWeekOffsetState] = useState(0);
  const [store, setStoreState] = useState<string>('');
  const [data, setData] = useState<ScheduleWeek | null | undefined>(undefined);
  const [edit, setEdit] = useState<EditCell | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    setOpen(readLocal<boolean>(preferenceKey, true));
  }, [preferenceKey]);
  const request = useRef<AbortController | null>(null);

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
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const qs = new URLSearchParams({ week: mondayOf(localToday(), weekOffset) });
    // Load all permitted locations so assignments at another store stay visible.
    // The server still enforces the viewer's location scope.
    return api<ScheduleWeek>(`/v1/schedule?${qs.toString()}`, { signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setData(next);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.status === 403) setData(null);
        else setData((d) => d ?? null);
      });
  }, [weekOffset]);
  useEffect(() => {
    setData(undefined);
    void load();
    return () => request.current?.abort();
  }, [load]);

  const canEdit = !!data?.canEdit && !readOnly;

  const rosters = useMemo(() => (data ? storeRosters(data, locationId) : []), [data, locationId]);
  const stats = useMemo(() => {
    const entries = rosters.flatMap((r) => [...r.days.values()].flat());
    const working = entries.filter(
      ({ shift }) => shift.startMinutes != null && shift.endMinutes != null,
    );
    const uncovered = rosters.flatMap((r) =>
      (data?.week.days ?? [])
        .filter((d) => !(r.days.get(d.date) ?? []).some(({ shift }) => shift.startMinutes != null))
        .map((d) => `${r.name} · ${d.dow}`),
    );
    return {
      people: new Set(working.map(({ person }) => person.membershipId)).size,
      shifts: working.length,
      hours: rosters.reduce((sum, r) => sum + r.hours, 0),
      unpublished: entries.filter(({ shift }) => !shift.published).length,
      uncovered,
    };
  }, [rosters, data]);

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
          locationId: edit.locationId ?? undefined,
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
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-expanded={open}
            onClick={() => {
              setOpen(!open);
              writeLocal(preferenceKey, !open);
            }}
            data-testid="schedule-toggle"
          >
            {open ? 'Hide detail' : 'Show detail'}
          </button>
          <div style={{ display: open ? 'contents' : 'none' }}>
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
                ? 'Open a day to view or schedule staff'
                : 'View only · Operations and the owner edit shifts'}
            </span>
            {canEdit && data && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy || stats.unpublished === 0}
                onClick={() => void publish()}
                data-testid="sched-publish"
              >
                Publish week
              </button>
            )}
          </div>
          {handle}
        </>
      }
    >
      <div hidden={!open}>
        {data === undefined ? (
          <ShimmerRows rows={4} />
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table className="sched-table sched-store-table" data-testid="sched-grid">
                <thead>
                  <tr>
                    <th scope="col">Store</th>
                    {data.week.days.map((d) => (
                      <th scope="col" key={d.date} className={d.isToday ? 'is-today' : undefined}>
                        {d.dow}
                        <span className="date">{d.date.slice(5).replace('-', '/')}</span>
                      </th>
                    ))}
                    <th scope="col">Hours</th>
                  </tr>
                </thead>
                <tbody>
                  {rosters.length === 0 && (
                    <tr>
                      <td colSpan={9} className="sched-empty">
                        No stores available in this view.
                      </td>
                    </tr>
                  )}
                  {rosters.map((row) => (
                    <tr key={row.id ?? 'unassigned'} data-testid="sched-row">
                      <th scope="row" className="sched-store-name">
                        {row.name}
                        <span className="date">
                          {row.locationType === 'warehouse' ? 'Warehouse' : 'Weekly coverage'}
                        </span>
                      </th>
                      {data.week.days.map((d) => {
                        const entries = row.days.get(d.date) ?? [];
                        const working = entries.filter(({ shift }) => shift.startMinutes != null);
                        const available = availableStaff(data.people, d.date);
                        const openEditor = (
                          person: SchedulePerson,
                          start: number | null,
                          end: number | null,
                        ) => {
                          setEdit({
                            person,
                            date: d.date,
                            dow: d.dow,
                            locationId: row.id,
                            locationName: row.name,
                            start,
                            end,
                          });
                        };
                        return (
                          <td key={d.date} className={d.isToday ? 'is-today' : undefined}>
                            <details className="sched-roster" key={`${row.id}-${d.date}`}>
                              <summary
                                className={working.length ? 'is-covered' : 'is-uncovered'}
                                aria-label={`${row.name}, ${dowDate(d.dow, d.date)}, ${working.length} scheduled`}
                              >
                                <span>
                                  {working.length ? `${working.length} scheduled` : 'No staff'}
                                </span>
                                <span className="sched-roster-preview">
                                  {working.length
                                    ? working.map(({ person }) => person.name).join(', ')
                                    : canEdit
                                      ? 'Add staff'
                                      : 'No coverage'}
                                </span>
                              </summary>
                              <div className="sched-roster-list">
                                {entries.map(({ person, shift }) => (
                                  <button
                                    key={person.membershipId}
                                    type="button"
                                    className={`sched-roster-person${shift.startMinutes == null ? ' is-off' : ''}`}
                                    disabled={!canEdit || busy}
                                    onClick={() =>
                                      openEditor(person, shift.startMinutes, shift.endMinutes)
                                    }
                                    data-testid="sched-cell"
                                  >
                                    <strong>{person.name}</strong>
                                    <span>
                                      {shift.startMinutes != null && shift.endMinutes != null
                                        ? shiftCompact(shift.startMinutes, shift.endMinutes)
                                        : 'Day off'}
                                      {!shift.published && ' · Draft'}
                                    </span>
                                  </button>
                                ))}
                                {canEdit &&
                                  row.id &&
                                  data.locations.some((l) => l.id === row.id) && (
                                    <select
                                      className="select sched-add-staff"
                                      value=""
                                      disabled={busy || !available.length}
                                      aria-label={`Add staff at ${row.name} on ${dowDate(d.dow, d.date)}`}
                                      onChange={(e) => {
                                        const person = available.find(
                                          (p) => p.membershipId === e.target.value,
                                        );
                                        if (person) openEditor(person, null, null);
                                      }}
                                    >
                                      <option value="">
                                        {available.length ? '+ Add staff' : 'Everyone scheduled'}
                                      </option>
                                      {available.map((person) => (
                                        <option
                                          key={person.membershipId}
                                          value={person.membershipId}
                                        >
                                          {person.name}
                                        </option>
                                      ))}
                                    </select>
                                  )}
                                {!entries.length && !canEdit && (
                                  <span className="sched-roster-preview">Nobody scheduled.</span>
                                )}
                              </div>
                            </details>
                          </td>
                        );
                      })}
                      <td className="mono sched-store-hours">
                        {row.hours ? hours1(row.hours) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div
              className="panel-foot"
              style={{ fontSize: 12.5, flexWrap: 'wrap' }}
              data-testid="sched-footer"
            >
              <span style={{ color: 'var(--muted)' }}>
                {rosters.length} stores · {stats.people} {stats.people === 1 ? 'person' : 'people'}{' '}
                · {stats.shifts} {stats.shifts === 1 ? 'shift' : 'shifts'} · {hours1(stats.hours)}{' '}
                scheduled hours
              </span>
              <span
                style={{
                  color: stats.uncovered.length === 0 ? 'var(--accent-ink)' : 'var(--warn)',
                }}
              >
                {rosters.length === 0
                  ? 'Add a store to start scheduling'
                  : stats.uncovered.length === 0
                    ? 'Every store covered each day'
                    : `${stats.uncovered.length} store-day${stats.uncovered.length === 1 ? '' : 's'} need coverage`}
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
                  <span style={{ color: stats.unpublished > 0 ? 'var(--warn)' : 'var(--muted)' }}>
                    {stats.unpublished > 0
                      ? `${stats.unpublished} unpublished change${stats.unpublished === 1 ? '' : 's'}`
                      : 'Published'}
                  </span>
                </span>
              )}
            </div>
          </>
        )}
        {edit && (
          <ShiftEditorDialog
            name={edit.person.name}
            dayLabel={`${edit.locationName} · ${dowDate(edit.dow, edit.date)}`}
            start={edit.start}
            end={edit.end}
            busy={busy}
            onSave={(s, e) => void save(s, e)}
            onDayOff={() => void dayOff()}
            onClose={() => {
              if (!busy) setEdit(null);
            }}
          />
        )}
      </div>
    </Panel>
  );
}
