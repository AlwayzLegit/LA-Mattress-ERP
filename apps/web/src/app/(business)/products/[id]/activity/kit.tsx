'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Alert, Select, StatGrid, StatTile } from '@/components/ui';
import type { ProductTab, Strip } from './types';
import { PRODUCT_TABS } from './types';

/** Shared bits of the View Product Activity sections (A21). */

export interface LocationOption {
  id: string;
  name: string;
  isActive: boolean;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `YYYY-MM-DD` or an ISO timestamp → `MM/DD/YYYY` (date-only strings never shift). */
export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (dateOnly) return `${dateOnly[2]}/${dateOnly[3]}/${dateOnly[1]}`;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString('en-US');
}

export function titleCase(s: string | null | undefined): string {
  if (!s) return '—';
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Active locations for the section pickers, fetched once per mount. */
export function useLocations(): LocationOption[] {
  const [rows, setRows] = useState<LocationOption[]>([]);
  useEffect(() => {
    api<LocationOption[]>('/v1/business/locations')
      .then((all) => setRows(all.filter((l) => l.isActive)))
      .catch(() => setRows([]));
  }, []);
  return rows;
}

/** Fetch one section; re-fetches whenever the URL changes. */
export function useSection<T>(url: string | null): {
  data: T | null;
  error: string | null;
  loading: boolean;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    setLoading(true);
    setError(null);
    api<T>(url)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((err) => {
        if (alive) setError(errorText(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [url]);
  return { data, error, loading };
}

export function LocationPicker({
  value,
  onChange,
  label = 'Location',
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  label?: string;
  testId?: string;
}) {
  const locations = useLocations();
  return (
    <label className="flex items-center gap-2">
      <span className="muted whitespace-nowrap">{label}</span>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        data-testid={testId}
      >
        <option value="">All locations</option>
        {locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </Select>
    </label>
  );
}

/** The four STORIS header quantities every section repeats. */
export function StripTiles({
  strip,
  extra,
}: {
  strip: Strip | null | undefined;
  extra?: { label: string; value: number | string }[];
}) {
  const s = strip;
  const tiles = [
    ...(extra ?? []),
    { label: 'On hand', value: s?.onHand ?? '—' },
    { label: 'As-Is', value: s?.asIsOnHand ?? '—' },
    { label: 'Net available', value: s?.available ?? '—' },
    { label: 'Net PO', value: s?.netOnPo ?? '—' },
  ];
  return (
    <StatGrid cols={tiles.length > 4 ? 5 : 4} data-testid="activity-strip">
      {tiles.map((t) => (
        <StatTile key={t.label} label={t.label} value={t.value} />
      ))}
    </StatGrid>
  );
}

export function SectionError({ error }: { error: string | null }) {
  return error ? <Alert tone="error">{error}</Alert> : null;
}

export function ProductSectionNav({
  tab,
  onPick,
}: {
  tab: ProductTab;
  onPick: (next: ProductTab) => void;
}) {
  return (
    <nav aria-label="Product activity views" className="card card-flush lg:sticky lg:top-4">
      {PRODUCT_TABS.map((t) => {
        const active = t.key === tab;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onPick(t.key)}
            aria-current={active ? 'page' : undefined}
            data-testid={`product-tab-${t.key}`}
            className={[
              'block w-full cursor-pointer border-0 border-b border-l-[3px] border-b-border px-3.5 py-2.5 text-left transition-colors last:border-b-0',
              active
                ? 'border-l-brand bg-surface-muted font-bold'
                : 'border-l-transparent bg-transparent font-medium hover:bg-surface-muted',
            ].join(' ')}
          >
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}
