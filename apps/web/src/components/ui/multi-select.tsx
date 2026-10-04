'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { cx } from './cx';

export interface MultiOption {
  value: string;
  label: string;
}

/**
 * A select-looking button that opens a checkbox list (owner 2026-10-03:
 * "add boxes next to each to select certain salespeople and/or stores").
 * Nothing ticked means "all" — the button then reads `allLabel`. The
 * summary names one or two picks and counts beyond that.
 */
export function MultiSelect({
  options,
  value,
  onChange,
  allLabel,
  noun,
  testId,
  className,
}: {
  options: MultiOption[];
  value: string[];
  onChange: (next: string[]) => void;
  /** Shown when nothing is ticked, e.g. "All stores" / "Anyone". */
  allLabel: string;
  /** Plural noun for the count, e.g. "stores". */
  noun: string;
  testId?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const picked = options.filter((o) => value.includes(o.value));
  const summary =
    picked.length === 0
      ? allLabel
      : picked.length <= 2
        ? picked.map((o) => o.label).join(', ')
        : `${picked.length} ${noun}`;

  const toggle = (v: string) =>
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  return (
    <div ref={wrap} className={cx('multi-select', className)}>
      <button
        type="button"
        className="select multi-select-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        data-testid={testId}
        onClick={() => setOpen((o) => !o)}
        title={picked.map((o) => o.label).join(', ') || allLabel}
      >
        <span className="multi-select-summary">{summary}</span>
        <span aria-hidden className="multi-select-chevron">
          ▾
        </span>
      </button>
      {open && (
        <div id={listId} role="listbox" aria-multiselectable className="multi-select-pop">
          <label className="multi-select-row multi-select-all">
            <input
              type="checkbox"
              checked={value.length === 0}
              onChange={() => onChange([])}
              data-testid={testId ? `${testId}-all` : undefined}
            />
            <span>{allLabel}</span>
          </label>
          {options.map((o) => (
            <label key={o.value} className="multi-select-row">
              <input
                type="checkbox"
                checked={value.includes(o.value)}
                onChange={() => toggle(o.value)}
                data-testid={testId ? `${testId}-opt` : undefined}
                data-value={o.value}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
