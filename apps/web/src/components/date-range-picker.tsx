'use client';

import { Calendar, ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DayPicker, type DateRange as DayRange } from 'react-day-picker';
import 'react-day-picker/style.css';
import {
  PRESETS,
  formatRange,
  isDay,
  lastPreset,
  localToday,
  parseLastPreset,
  presetLabel,
  quarterOf,
  quarterPreset,
  rangeFor,
  rangeFromSearch,
  rangeToSearch,
  toDay,
  type DateRange,
  type FixedPreset,
  type LastUnit,
  type RangePreset,
} from '@/lib/date-range';

/**
 * Shopify-style date range picker (owner 2026-09-02): one button that
 * reads "Last 7 days · Aug 27 – Sep 2, 2026" and opens a panel with the
 * preset list on the left, a "Last N days/weeks/months · include today"
 * control and a two-month calendar on the right, and the chosen range
 * with Cancel / Apply along the bottom. One shared component; a page can
 * mount several, each keyed to its own URL params, so a section can carry
 * its own window.
 */

type Mode = 'quick' | 'last' | 'to_date' | 'quarters' | 'custom';

function fromDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

function modeFor(preset: RangePreset): Mode {
  if (preset === 'custom') return 'custom';
  if (preset === 'today' || preset === 'yesterday') return 'quick';
  if (preset.startsWith('q') && /^q[1-4]_\d{4}$/.test(preset)) return 'quarters';
  if (['wtd', 'mtd', 'qtd', 'ytd'].includes(preset)) return 'to_date';
  return 'last';
}

export function DateRangePicker({
  value,
  onChange,
  align = 'right',
  maxDate,
  testid = 'date-range',
  compact = false,
  allowAllTime = false,
}: {
  value: DateRange;
  onChange: (next: DateRange) => void;
  align?: 'left' | 'right';
  /** Latest selectable day (defaults to today). */
  maxDate?: string;
  testid?: string;
  /** Card-header size: smaller button, dates only in the tooltip. */
  compact?: boolean;
  /** Offer "All time" (an open-ended window) at the top of the list. */
  allowAllTime?: boolean;
}) {
  const today = maxDate ?? localToday();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>(value);
  const [mode, setMode] = useState<Mode>(modeFor(value.preset));
  const [lastN, setLastN] = useState(7);
  const [lastUnit, setLastUnit] = useState<LastUnit>('days');
  const [includeToday, setIncludeToday] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [singleMonth, setSingleMonth] = useState(false);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Anchor to the trigger, but clamp to the visible viewport rather than the
  // report card. A portal also avoids clipping by scrolling tables/cards.
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const panel = panelRef.current;
      const trigger = triggerRef.current;
      if (!panel || !trigger) return;
      const viewport = window.visualViewport;
      const width = viewport?.width ?? document.documentElement.clientWidth;
      const height = viewport?.height ?? window.innerHeight;
      const x = viewport?.offsetLeft ?? 0;
      const y = viewport?.offsetTop ?? 0;
      const gutter = 12;
      setSingleMonth(width < 740);
      panel.style.width = `${Math.min(720, Math.max(0, width - gutter * 2))}px`;
      panel.style.maxHeight = `${Math.max(0, height - gutter * 2)}px`;
      const anchor = trigger.getBoundingClientRect();
      const box = panel.getBoundingClientRect();
      let preferredLeft = align === 'right' ? anchor.right - box.width : anchor.left;
      const alternateLeft = align === 'right' ? anchor.left : anchor.right - box.width;
      if (
        (preferredLeft < x + gutter || preferredLeft + box.width > x + width - gutter) &&
        alternateLeft >= x + gutter &&
        alternateLeft + box.width <= x + width - gutter
      )
        preferredLeft = alternateLeft;
      const left = Math.max(x + gutter, Math.min(preferredLeft, x + width - box.width - gutter));
      const below = anchor.bottom + 6;
      const above = anchor.top - box.height - 6;
      const preferredTop = below + box.height <= y + height - gutter ? below : above;
      const top = Math.max(y + gutter, Math.min(preferredTop, y + height - box.height - gutter));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [open, align]);

  // Re-seed the draft each time the panel opens from the committed value.
  useEffect(() => {
    if (!open) return;
    setDraft(value);
    setMode(modeFor(value.preset));
    const last = parseLastPreset(value.preset);
    if (last) {
      setLastN(last.n);
      setLastUnit(last.unit);
      setIncludeToday(last.includeToday);
    } else if (value.preset === 'last7' || value.preset === 'last30' || value.preset === 'last90') {
      setLastN(Number(value.preset.slice(4)));
      setLastUnit('days');
      setIncludeToday(true);
    }
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        !rootRef.current?.contains(e.target as Node) &&
        !panelRef.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const setPreset = (preset: FixedPreset) => {
    setDraft(rangeFor(preset, today));
    setMode(modeFor(preset));
  };
  const setLast = (n: number, unit: LastUnit, inc: boolean) => {
    setLastN(n);
    setLastUnit(unit);
    setIncludeToday(inc);
    if (Number.isInteger(n) && n >= 1) {
      const preset =
        unit === 'days' && inc && [7, 30, 90].includes(n)
          ? (`last${n}` as FixedPreset)
          : lastPreset(n, unit, inc);
      setDraft(rangeFor(preset, today));
    }
    setMode('last');
  };

  const selected: DayRange = useMemo(
    () => ({ from: fromDay(draft.start), to: fromDay(draft.end) }),
    [draft.start, draft.end],
  );
  const onSelectDays = (r: DayRange | undefined) => {
    if (!r?.from) return;
    const start = toDay(r.from);
    const end = toDay(r.to ?? r.from);
    setDraft({ preset: 'custom', start, end: end > today ? today : end });
    setMode('custom');
  };

  const invalid = !isDay(draft.start) || !isDay(draft.end) || draft.start > draft.end;
  const unchanged =
    draft.preset === value.preset && draft.start === value.start && draft.end === value.end;
  const apply = () => {
    if (invalid) return;
    onChange(draft);
    close();
  };

  const { q, year } = quarterOf(today);
  const quarters: { key: FixedPreset; label: string }[] = [];
  for (let i = 0; i < 6; i++) {
    let qq = q - i;
    let yy = year;
    while (qq < 1) {
      qq += 4;
      yy -= 1;
    }
    quarters.push({ key: quarterPreset(qq as 1 | 2 | 3 | 4, yy), label: `Q${qq} ${yy}` });
  }

  const item = (
    key: string,
    label: string,
    active: boolean,
    onClick: () => void,
    indent = false,
  ) => (
    <li key={key}>
      <button
        type="button"
        role="option"
        aria-selected={active}
        onClick={onClick}
        data-testid={`${testid}-preset-${key}`}
        className={`drp-item${active ? ' is-active' : ''}`}
        style={indent ? { paddingLeft: 22 } : undefined}
      >
        {label}
      </button>
    </li>
  );

  const label =
    value.preset === 'all'
      ? 'All time'
      : value.preset === 'custom' && compact
        ? formatRange(value)
        : presetLabel(value.preset);

  return (
    <div ref={rootRef} className="drp" data-testid={testid}>
      <button
        ref={triggerRef}
        type="button"
        className={`btn drp-trigger${compact ? ' is-compact' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={`${testid}-trigger`}
        title={value.preset === 'all' ? 'All time' : formatRange(value)}
      >
        <Calendar size={compact ? 13 : 15} aria-hidden className="drp-icon" />
        <span className="drp-label">{label}</span>
        {!compact && value.preset !== 'all' && (
          <span className="drp-dates">· {formatRange(value)}</span>
        )}
        <ChevronDown size={compact ? 12 : 14} aria-hidden className="drp-icon" />
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Choose a date range"
            data-testid={`${testid}-panel`}
            className={`drp-panel${singleMonth ? ' is-single-month' : ''}`}
          >
            <ul role="listbox" aria-label="Presets" className="drp-presets">
              {allowAllTime &&
                item('all', 'All time', draft.preset === 'all', () => {
                  setDraft({ preset: 'all', start: '2000-01-01', end: today });
                  setMode('quick');
                })}
              {PRESETS.filter((p) => p.group === 'quick').map((p) =>
                item(p.key, p.label, draft.preset === p.key, () => setPreset(p.key)),
              )}
              <li className="drp-sep" aria-hidden />
              {item('last', 'Last…', mode === 'last', () => setLast(lastN, lastUnit, includeToday))}
              {mode === 'last' &&
                PRESETS.filter((p) => p.group === 'last').map((p) =>
                  item(p.key, p.label, draft.preset === p.key, () => setPreset(p.key), true),
                )}
              {item('to_date', 'Period to date', mode === 'to_date', () => setPreset('mtd'))}
              {mode === 'to_date' &&
                PRESETS.filter((p) => p.group === 'to_date').map((p) =>
                  item(p.key, p.label, draft.preset === p.key, () => setPreset(p.key), true),
                )}
              {item('previous', 'Previous period', mode === 'quick' && false, () =>
                setPreset('last_month'),
              )}
              {PRESETS.filter((p) => p.group === 'previous').map((p) =>
                item(p.key, p.label, draft.preset === p.key, () => setPreset(p.key), true),
              )}
              <li className="drp-sep" aria-hidden />
              {item('quarters', 'Quarters', mode === 'quarters', () => setPreset(quarters[0]!.key))}
              {mode === 'quarters' &&
                quarters.map((qq) =>
                  item(qq.key, qq.label, draft.preset === qq.key, () => setPreset(qq.key), true),
                )}
              <li className="drp-sep" aria-hidden />
              {item('custom', 'Custom range', mode === 'custom', () => setMode('custom'))}
            </ul>

            <div className="drp-main">
              <div className="drp-last">
                <span>Last</span>
                <input
                  type="number"
                  min={1}
                  max={366}
                  className="input drp-last-n"
                  value={lastN}
                  onChange={(e) => setLast(Number(e.target.value), lastUnit, includeToday)}
                  data-testid={`${testid}-last-n`}
                  aria-label="Number of periods"
                />
                <select
                  className="input drp-last-unit"
                  value={lastUnit}
                  onChange={(e) => setLast(lastN, e.target.value as LastUnit, includeToday)}
                  data-testid={`${testid}-last-unit`}
                  aria-label="Period unit"
                >
                  <option value="days">Days</option>
                  <option value="weeks">Weeks</option>
                  <option value="months">Months</option>
                </select>
                <label className="drp-include">
                  <input
                    type="checkbox"
                    checked={includeToday}
                    onChange={(e) => setLast(lastN, lastUnit, e.target.checked)}
                    data-testid={`${testid}-include-today`}
                  />
                  Include today
                </label>
              </div>

              <DayPicker
                mode="range"
                numberOfMonths={singleMonth ? 1 : 2}
                selected={selected}
                onSelect={onSelectDays}
                defaultMonth={fromDay(draft.start)}
                disabled={{ after: fromDay(today) }}
                weekStartsOn={0}
                showOutsideDays={false}
                className="drp-calendar"
              />

              <div className="drp-footer">
                <div className="drp-summary" data-testid={`${testid}-summary`}>
                  {invalid
                    ? 'Pick a start on or before the end.'
                    : draft.preset === 'all'
                      ? 'All time'
                      : formatRange(draft)}
                </div>
                <div className="drp-actions">
                  <label className="drp-custom-dates">
                    <input
                      type="date"
                      className="input"
                      value={draft.start}
                      max={draft.end || today}
                      onChange={(e) => {
                        setDraft({ preset: 'custom', start: e.target.value, end: draft.end });
                        setMode('custom');
                      }}
                      data-testid={`${testid}-start`}
                      aria-label="Start date"
                    />
                    <span aria-hidden>–</span>
                    <input
                      type="date"
                      className="input"
                      value={draft.end}
                      min={draft.start}
                      max={today}
                      onChange={(e) => {
                        setDraft({ preset: 'custom', start: draft.start, end: e.target.value });
                        setMode('custom');
                      }}
                      data-testid={`${testid}-end`}
                      aria-label="End date"
                    />
                  </label>
                  <button
                    type="button"
                    className="btn"
                    onClick={close}
                    data-testid={`${testid}-cancel`}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={apply}
                    disabled={invalid || unchanged}
                    data-testid={`${testid}-apply`}
                  >
                    Apply
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/**
 * Range state that lives in the URL (`?range=` or `?start=&end=`), read
 * once on mount and written with replaceState so Back/Forward and reload
 * keep the window. `fallback` is the preset used when the URL has none;
 * `key` namespaces the params for a section-level picker
 * (`deliveries.range`, `deliveries.start`, …).
 */
export function useUrlDateRange(
  fallback: FixedPreset,
  options: { key?: string } = {},
): [DateRange, (next: DateRange) => void, boolean] {
  const { key } = options;
  const [range, setRangeState] = useState<DateRange>(() => rangeFor(fallback));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setRangeState(
      rangeFromSearch(new URLSearchParams(window.location.search), fallback, undefined, key),
    );
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read the URL once on mount
  }, []);

  const setRange = useCallback(
    (next: DateRange) => {
      setRangeState(next);
      const url = new URL(window.location.href);
      rangeToSearch(next, url.searchParams, key);
      window.history.replaceState(null, '', url.toString());
    },
    [key],
  );

  return [range, setRange, ready];
}
