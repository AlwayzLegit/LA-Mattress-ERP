'use client';

import { useEffect, useState } from 'react';
import { minutesLabel } from './kit';

/**
 * The shift editor (hand-off 2026-09-10, step 2): a 400px dialog with
 * Starts (6:00 AM – 2:00 PM) and Ends (1:00 PM – 10:00 PM) in 30-minute
 * steps, the shift length under them, Save shift and Day off.
 */
const STARTS = Array.from({ length: 17 }, (_, i) => 360 + i * 30); // 6:00 AM … 2:00 PM
const ENDS = Array.from({ length: 19 }, (_, i) => 780 + i * 30); // 1:00 PM … 10:00 PM

export function ShiftEditorDialog({
  name,
  dayLabel,
  start,
  end,
  busy,
  onSave,
  onDayOff,
  onClose,
}: {
  name: string;
  dayLabel: string;
  start: number | null;
  end: number | null;
  busy: boolean;
  onSave: (start: number, end: number) => void;
  onDayOff: () => void;
  onClose: () => void;
}) {
  const [s, setS] = useState(start ?? 540);
  const [e, setE] = useState(end ?? 1020);
  const invalid = e <= s;
  const hours = ((e - s) / 60).toFixed(1);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay overlay-center" onClick={onClose} data-noprint="true">
      <div
        role="dialog"
        aria-modal
        aria-label={`Shift for ${name}`}
        className="dialog"
        style={{ width: 400 }}
        onClick={(ev) => ev.stopPropagation()}
        data-testid="shift-editor"
      >
        <div className="dialog-head">
          <h3>{name}</h3>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{dayLabel}</span>
          <button
            type="button"
            className="icon-btn"
            style={{ marginLeft: 'auto' }}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label style={{ fontSize: 12, color: 'var(--muted)' }}>
              Starts
              <select
                className="shift-select"
                style={{ marginTop: 4 }}
                value={s}
                onChange={(ev) => setS(Number(ev.target.value))}
                data-testid="shift-start"
              >
                {STARTS.map((m) => (
                  <option key={m} value={m}>
                    {minutesLabel(m)}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: 12, color: 'var(--muted)' }}>
              Ends
              <select
                className="shift-select"
                style={{ marginTop: 4 }}
                value={e}
                onChange={(ev) => setE(Number(ev.target.value))}
                data-testid="shift-end"
              >
                {ENDS.map((m) => (
                  <option key={m} value={m}>
                    {minutesLabel(m)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div
            style={{ fontSize: 12.5, color: invalid ? 'var(--danger)' : 'var(--muted)' }}
            data-testid="shift-summary"
          >
            {invalid
              ? 'End time must be after the start time'
              : `${hours} hour shift · ${minutesLabel(s)} to ${minutesLabel(e)}`}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1 }}
              disabled={busy || invalid}
              onClick={() => onSave(s, e)}
              data-testid="shift-save"
            >
              Save shift
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ color: 'var(--danger)' }}
              disabled={busy}
              onClick={onDayOff}
              data-testid="shift-day-off"
            >
              Day off
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
