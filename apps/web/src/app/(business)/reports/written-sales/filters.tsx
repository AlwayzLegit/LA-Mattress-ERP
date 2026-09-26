'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cx } from '@/components/ui';
import styles from './written-sales.module.css';

/** A small popover anchored under a button; closes on outside click or Escape. */
export function Popover({
  label,
  active,
  children,
  testid,
  align = 'left',
}: {
  label: ReactNode;
  /** Draws the button as "set" (a filter narrowed from its default). */
  active?: boolean;
  children: ReactNode;
  testid?: string;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
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
  return (
    <div className={styles.popWrap} ref={ref}>
      <button
        type="button"
        className={cx(styles.popBtn, active && styles.popBtnActive)}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid={testid}
      >
        {label}
        <ChevronDown size={13} aria-hidden />
      </button>
      {open && (
        <div
          className={cx(styles.popPanel, align === 'right' && styles.popRight)}
          role="dialog"
          data-testid={testid ? `${testid}-panel` : undefined}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** Stores as a checklist: none ticked means every location. */
export function StoreSelect({
  locations,
  value,
  onChange,
}: {
  locations: { id: string; name: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const label =
    value.length === 0
      ? 'All stores'
      : value.length === 1
        ? (locations.find((l) => l.id === value[0])?.name ?? '1 store')
        : `${value.length} stores`;
  return (
    <Popover label={label} active={value.length > 0} testid="ws-stores">
      <label className={styles.popOption}>
        <input
          type="checkbox"
          checked={value.length === 0}
          onChange={() => onChange([])}
          data-testid="ws-stores-all"
        />
        All stores
      </label>
      <hr className={styles.popRule} />
      {locations.map((l) => (
        <label key={l.id} className={styles.popOption}>
          <input
            type="checkbox"
            checked={value.includes(l.id)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, l.id] : value.filter((x) => x !== l.id))
            }
          />
          {l.name}
        </label>
      ))}
    </Popover>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  testid,
}: {
  options: { key: T; label: string; hint?: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  testid: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label} data-testid={testid}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={value === o.key}
          title={o.hint}
          className={cx('seg-btn', value === o.key && 'is-active')}
          onClick={() => onChange(o.key)}
          data-testid={`${testid}-${o.key}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
