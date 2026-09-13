'use client';

import { GripVertical } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { cx } from './cx';
import type { SortDir } from './table';

/**
 * Reorderable, sortable list columns (owner 2026-09-12: "similar to how we
 * have it inside of Products — do the same for everything that has a
 * list"). A screen declares its columns once; the header row is drag-to-
 * move (grip at the left of each header) and click-to-sort (`aria-sort`),
 * the order is remembered per browser under `jetnine.columns.<key>`, and
 * the cells render in whatever order the header is in.
 *
 * Sorting is client-side over the rows on screen unless the screen passes
 * a `server` sort (Products and Orders ask the API); a column without
 * `sortValue` / `sortKey` is a plain label.
 */

export type SortValue = string | number | boolean | Date | null | undefined;

export interface ColumnDef<Row> {
  id: string;
  label: ReactNode;
  /** Right-aligned numbers. */
  num?: boolean;
  /** Extra class on both the header and the cell (`nowrap`, `actions`, …). */
  className?: string;
  /** Extra cell class that depends on the row (a due balance's tint). */
  cellClassName?: (row: Row) => string | false | null | undefined;
  /** Header-only class (Products' store tint). */
  thClassName?: string;
  /** Client-side sort key; omit for an unsortable column. */
  sortValue?: (row: Row) => SortValue;
  /** Server-side sort key when the screen sorts through the API. */
  sortKey?: string;
  /** Header tooltip. */
  title?: string;
  /** Screen-reader label for an icon-only or actions header. */
  srLabel?: string;
  /** Keeps its place: never dragged, never a drop target (actions column). */
  fixed?: boolean;
  render: (row: Row, index: number) => ReactNode;
}

const KEY_PREFIX = 'jetnine.columns.';

/** Merge a saved order with the current column set: unknown ids drop, new ids append. */
export function applySavedOrder(saved: unknown, defaultOrder: string[]): string[] {
  if (!Array.isArray(saved)) return defaultOrder;
  const known = saved.filter((id): id is string => defaultOrder.includes(String(id)));
  if (known.length === 0) return defaultOrder;
  return [...known, ...defaultOrder.filter((id) => !known.includes(id))];
}

/**
 * Drop `from` on `to`: dragging right lands after the target, dragging
 * left lands before it, so any slot is reachable. Fixed ids stay put.
 */
export function moveId(order: string[], from: string, to: string, fixed: Set<string>): string[] {
  if (from === to || fixed.has(from) || fixed.has(to)) return order;
  const fromIdx = order.indexOf(from);
  const toIdx = order.indexOf(to);
  if (fromIdx < 0 || toIdx < 0) return order;
  const next = order.filter((id) => id !== from);
  const at = next.indexOf(to) + (fromIdx < toIdx ? 1 : 0);
  next.splice(at, 0, from);
  return next;
}

function rank(v: SortValue): [number, number | string] {
  if (v == null || v === '') return [1, 0];
  if (v instanceof Date) return [0, v.getTime()];
  if (typeof v === 'boolean') return [0, v ? 1 : 0];
  if (typeof v === 'number') return [0, Number.isNaN(v) ? Number.NEGATIVE_INFINITY : v];
  return [0, String(v)];
}

/** Numbers and dates numerically, text with locale rules, blanks last either way. */
export function compareSortValues(a: SortValue, b: SortValue): number {
  const [na, va] = rank(a);
  const [nb, vb] = rank(b);
  if (na !== nb) return na - nb;
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
}

/** Stable sort; blanks stay last whichever way the column points. */
export function sortRows<Row>(
  rows: Row[],
  column: ColumnDef<Row> | undefined,
  dir: SortDir,
): Row[] {
  if (!column?.sortValue) return rows;
  const get = column.sortValue;
  return rows
    .map((row, i) => ({ row, i, v: get(row) }))
    .sort((x, y) => {
      const blankX = x.v == null || x.v === '';
      const blankY = y.v == null || y.v === '';
      if (blankX !== blankY) return blankX ? 1 : -1;
      const c = compareSortValues(x.v, y.v);
      return (dir === 'desc' ? -c : c) || x.i - y.i;
    })
    .map((x) => x.row);
}

export interface ServerSort {
  sort: string;
  dir: SortDir;
  onSort: (key: string) => void;
}

export interface ListColumns<Row> {
  /** Columns in the order they render. */
  ordered: ColumnDef<Row>[];
  /** Sorted copy of the rows (the same array when the sort is server-side). */
  sorted: Row[];
  sort: string;
  dir: SortDir;
  toggleSort: (id: string) => void;
  move: (from: string, to: string) => void;
  reset: () => void;
  /** True once the user has moved a column. */
  isCustom: boolean;
}

/**
 * Column order + sort state for one list. `key` names the screen for
 * storage. Pass `server` when the API sorts; otherwise rows sort here.
 */
export function useListColumns<Row>(
  key: string,
  columns: ColumnDef<Row>[],
  rows: Row[] | null | undefined,
  opts: { server?: ServerSort; initialSort?: string; initialDir?: SortDir } = {},
): ListColumns<Row> {
  // Screens may build their column array inline (a render closure needs
  // component state), so key everything on the ids, not the array identity.
  const idsKey = columns.map((c) => c.id).join('\u0001');
  const fixedKey = columns
    .filter((c) => c.fixed)
    .map((c) => c.id)
    .join('\u0001');
  const defaultOrder = useMemo(() => (idsKey ? idsKey.split('\u0001') : []), [idsKey]);
  const fixed = useMemo(() => new Set(fixedKey ? fixedKey.split('\u0001') : []), [fixedKey]);
  const [order, setOrder] = useState<string[]>(defaultOrder);
  const [localSort, setLocalSort] = useState(opts.initialSort ?? '');
  const [localDir, setLocalDir] = useState<SortDir>(opts.initialDir ?? 'asc');

  useEffect(() => {
    let next = defaultOrder;
    try {
      const raw = localStorage.getItem(KEY_PREFIX + key);
      next = applySavedOrder(raw ? JSON.parse(raw) : null, defaultOrder);
    } catch {
      next = defaultOrder;
    }
    setOrder((cur) => (cur.join() === next.join() ? cur : next));
  }, [key, defaultOrder]);

  const persist = useCallback(
    (next: string[]) => {
      setOrder(next);
      try {
        if (next.join() === defaultOrder.join()) localStorage.removeItem(KEY_PREFIX + key);
        else localStorage.setItem(KEY_PREFIX + key, JSON.stringify(next));
      } catch {
        // storage unavailable — the order lasts for this page only
      }
    },
    [key, defaultOrder],
  );

  const move = useCallback(
    (from: string, to: string) => persist(moveId(order, from, to, fixed)),
    [order, fixed, persist],
  );
  const reset = useCallback(() => persist(defaultOrder), [persist, defaultOrder]);

  const byId = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const ordered = useMemo(
    () => order.map((id) => byId.get(id)).filter((c): c is ColumnDef<Row> => !!c),
    [order, byId],
  );

  const sort = opts.server ? opts.server.sort : localSort;
  const dir = opts.server ? opts.server.dir : localDir;
  const toggleSort = useCallback(
    (id: string) => {
      const col = byId.get(id);
      if (!col) return;
      if (opts.server) {
        if (col.sortKey) opts.server.onSort(col.sortKey);
        return;
      }
      if (!col.sortValue) return;
      if (localSort === id) setLocalDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      else {
        setLocalSort(id);
        setLocalDir('asc');
      }
    },
    [byId, opts.server, localSort],
  );

  const sorted = useMemo(() => {
    if (!rows) return [];
    if (opts.server) return rows;
    return sortRows(rows, byId.get(localSort), localDir);
  }, [rows, opts.server, byId, localSort, localDir]);

  return {
    ordered,
    sorted,
    sort,
    dir,
    toggleSort,
    move,
    reset,
    isCustom: order.join() !== defaultOrder.join(),
  };
}

/** The `<tr>` of headers: grip to drag, button to sort, `aria-sort` on the th. */
export function ColumnHeadRow<Row>({
  list,
  testIdPrefix,
}: {
  list: ListColumns<Row>;
  /** `${prefix}-col-${id}` on the th and `${prefix}-sort-${id}` on the button. */
  testIdPrefix?: string;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const server = list.ordered.some((c) => c.sortKey);
  return (
    <tr>
      {list.ordered.map((c) => {
        const sortId = server ? c.sortKey : c.sortValue ? c.id : undefined;
        const on = !!sortId && list.sort === sortId;
        const draggable = !c.fixed;
        const label = c.srLabel ? <span className="sr-only">{c.srLabel}</span> : c.label;
        return (
          <th
            key={c.id}
            draggable={draggable}
            onDragStart={draggable ? () => setDragId(c.id) : undefined}
            onDragOver={
              draggable
                ? (e) => {
                    e.preventDefault();
                    if (dropId !== c.id) setDropId(c.id);
                  }
                : undefined
            }
            onDragLeave={draggable ? () => dropId === c.id && setDropId(null) : undefined}
            onDrop={
              draggable
                ? (e) => {
                    e.preventDefault();
                    if (dragId) list.move(dragId, c.id);
                    setDragId(null);
                    setDropId(null);
                  }
                : undefined
            }
            onDragEnd={
              draggable
                ? () => {
                    setDragId(null);
                    setDropId(null);
                  }
                : undefined
            }
            aria-sort={
              sortId ? (on ? (list.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined
            }
            className={cx(
              c.num && 'num',
              c.className,
              c.thClassName,
              draggable && 'th-draggable',
              dropId === c.id && dragId !== c.id && 'th-drop',
            )}
            title={
              c.title ??
              (draggable
                ? sortId
                  ? 'Click to sort · drag to move this column'
                  : 'Drag to move this column'
                : undefined)
            }
            data-testid={testIdPrefix ? `${testIdPrefix}-col-${c.id}` : undefined}
          >
            {draggable && (
              <span className="th-grip" aria-hidden>
                <GripVertical size={12} />
              </span>
            )}
            {sortId ? (
              <button
                type="button"
                className={cx('col-sort', on && 'is-on')}
                onClick={() => list.toggleSort(c.id)}
                data-testid={testIdPrefix ? `${testIdPrefix}-sort-${c.id}` : `sort-${c.id}`}
              >
                {label}
                <span className="col-sort-arrow" aria-hidden>
                  {on ? (list.dir === 'asc' ? '▲' : '▼') : ''}
                </span>
              </button>
            ) : (
              label
            )}
          </th>
        );
      })}
    </tr>
  );
}

/** The `<td>`s of one row, in the header's order. */
export function ColumnCells<Row>({
  list,
  row,
  index = 0,
}: {
  list: ListColumns<Row>;
  row: Row;
  index?: number;
}) {
  return (
    <>
      {list.ordered.map((c) => (
        <td key={c.id} className={cx(c.num && 'num', c.className, c.cellClassName?.(row))}>
          {c.render(row, index)}
        </td>
      ))}
    </>
  );
}

/** Ghost "Reset columns" link, only once the order differs from the default. */
export function ResetColumns<Row>({ list }: { list: ListColumns<Row> }) {
  if (!list.isCustom) return null;
  return (
    <button type="button" className="col-reset" onClick={list.reset} data-testid="reset-columns">
      Reset columns
    </button>
  );
}
