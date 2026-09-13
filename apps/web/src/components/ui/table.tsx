'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { cx } from './cx';

/**
 * Row-as-link (canvas 2e): the anchor in the first cell is what the
 * keyboard lands on; its ::after overlay (`.row-link`) makes the whole
 * row clickable. Put `className="row"` on the `<tr>` so the overlay has
 * a positioned ancestor, and keep other controls in the row above it
 * with `.row-action`.
 */
export function RowLink({
  href,
  className,
  children,
  mono = true,
  ...rest
}: {
  href: string;
  className?: string;
  children: ReactNode;
  /** Document numbers are mono 12.5px / 500. */
  mono?: boolean;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return (
    <Link {...rest} href={href} className={cx('row-link', mono && 'row-link-mono', className)}>
      {children}
    </Link>
  );
}

export type SortDir = 'asc' | 'desc';

/**
 * Sortable column header: a `<th aria-sort>` wrapping a button that
 * inherits the header type. The indicator is drawn by CSS from
 * `aria-sort`, so the label is the only text.
 */
export function SortHeader({
  id,
  active,
  dir,
  onSort,
  align,
  children,
  className,
  testId,
  ...rest
}: {
  id: string;
  active: boolean;
  dir: SortDir;
  onSort: (id: string) => void;
  align?: 'right';
  children: ReactNode;
  className?: string;
  testId?: string;
} & Omit<React.ThHTMLAttributes<HTMLTableCellElement>, 'align'>) {
  return (
    <th
      {...rest}
      aria-sort={active ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'}
      className={cx(align === 'right' && 'num', className)}
    >
      <button
        type="button"
        className="sort-btn"
        onClick={() => onSort(id)}
        data-testid={testId ?? `sort-${id}`}
      >
        {children}
      </button>
    </th>
  );
}

/**
 * Keyboard access for a clickable `<tr>` that has no anchor of its own
 * (Phase 12): spread onto the row so Tab reaches it and Enter / Space run
 * its onClick. A nested control keeps its own keys — the row only acts
 * when the row itself is the target.
 */
export const rowKeys = {
  role: 'link' as const,
  tabIndex: 0,
  onKeyDown: (e: React.KeyboardEvent<HTMLTableRowElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.currentTarget.click();
    }
  },
};
