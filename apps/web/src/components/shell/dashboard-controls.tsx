'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DateRangePicker } from '@/components/date-range-picker';
import { formatRange } from '@/lib/date-range';
import {
  useDashboardFilters,
  type CompareMode,
  type RoleView,
  type StoreOption,
} from '@/lib/dashboard-filters';

/**
 * The owner's role-home switch (topbar, owners only — a preview tool) and
 * the store-scope + period controls, which live on the dashboard itself
 * since redesign Phase 3 (README §2: period controls are not the shell's).
 */

export function DashboardControls() {
  return (
    <div className="dash-controls" data-testid="dashboard-controls">
      <StoreScope />
      <PeriodControls />
    </div>
  );
}

const ROLE_OPTIONS: { key: RoleView; label: string }[] = [
  { key: 'owner', label: 'Owner' },
  { key: 'manager', label: 'Manager' },
  { key: 'ops', label: 'Operations' },
  { key: 'warehouse', label: 'Warehouse' },
];

export function RoleSwitcher() {
  const f = useDashboardFilters();
  const router = useRouter();
  const pathname = usePathname();
  const active = f.roleView ?? 'owner';
  return (
    <div
      className="seg seg-lg"
      role="tablist"
      aria-label="Dashboard view"
      data-testid="role-switcher"
    >
      {ROLE_OPTIONS.map((r) => (
        <button
          key={r.key}
          type="button"
          role="tab"
          aria-selected={active === r.key}
          className={`seg-btn${active === r.key ? ' is-active' : ''}`}
          onClick={() => {
            f.setRoleView(r.key === 'owner' ? null : r.key);
            if (pathname !== '/dashboard') router.push('/dashboard');
          }}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

function tzShort(tz: string): string {
  if (/Los_Angeles|Vancouver|Tijuana/.test(tz)) return 'PT';
  if (/Denver|Phoenix|Edmonton/.test(tz)) return 'MT';
  if (/Chicago|Winnipeg/.test(tz)) return 'CT';
  if (/New_York|Toronto|Detroit/.test(tz)) return 'ET';
  return tz.split('/').pop()?.replace(/_/g, ' ') ?? tz;
}

export function StoreScope() {
  const f = useDashboardFilters();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const all = f.storeIds == null;
  const selected = new Set(f.storeIds ?? f.stores.map((s) => s.id));
  const groups: { label: string; stores: StoreOption[] }[] = [
    { label: 'Stores', stores: f.stores.filter((s) => s.locationType !== 'warehouse') },
    { label: 'Warehouse', stores: f.stores.filter((s) => s.locationType === 'warehouse') },
  ].filter((g) => g.stores.length > 0);

  const toggle = (id: string) => {
    let next = [...selected];
    next = next.includes(id) ? next.filter((x) => x !== id) : [...next, id];
    if (next.length === 0) next = [id];
    f.setStoreIds(next.length === f.stores.length ? null : next);
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="topbar-btn"
        onClick={() => setOpen((v) => !v)}
        data-testid="store-scope"
      >
        <span style={{ color: 'var(--muted)' }}>⌂</span>
        {f.storeLabel}
        <span style={{ color: 'var(--muted)', fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="menu" style={{ width: 260 }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 12px',
                borderBottom: '1px solid var(--border)',
                fontSize: 12.5,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={all}
                onChange={() => f.setStoreIds(null)}
                style={{ accentColor: 'var(--accent)' }}
              />
              All stores{' '}
              <span className="mono" style={{ color: 'var(--muted)', fontWeight: 400 }}>
                {f.stores.length}
              </span>
            </label>
            {groups.map((g) => (
              <div key={g.label} style={{ padding: '6px 0' }}>
                <div className="eyebrow" style={{ fontSize: 10.5, padding: '2px 12px 4px' }}>
                  {g.label}
                </div>
                {g.stores.map((s) => (
                  <label
                    key={s.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '5px 12px',
                      fontSize: 12.5,
                      cursor: 'pointer',
                    }}
                    className="hover:bg-surface-2"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(s.id)}
                      onChange={() => toggle(s.id)}
                      style={{ accentColor: 'var(--accent)' }}
                    />
                    <span style={{ flex: 1 }}>{s.name}</span>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {tzShort(s.timezone)}
                    </span>
                  </label>
                ))}
              </div>
            ))}
            <div className="panel-foot" style={{ justifyContent: 'flex-end', borderRadius: 0 }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => setOpen(false)}
              >
                Done
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const COMPARE: { key: CompareMode; label: string }[] = [
  { key: 'none', label: 'Nothing' },
  { key: 'prior', label: 'Prior period' },
  { key: 'year', label: 'Last year' },
];

export function PeriodControls() {
  const f = useDashboardFilters();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <DateRangePicker
        value={f.range}
        onChange={f.setRange}
        compact
        align="right"
        testid="trend-range"
      />
      <div
        className="seg"
        title={f.compareRange ? `Compared to ${formatRange(f.compareRange)}` : 'No comparison'}
      >
        {COMPARE.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`seg-btn${f.compare === c.key ? ' is-active' : ''}`}
            onClick={() => f.setCompare(c.key)}
            aria-pressed={f.compare === c.key}
          >
            {c.key === 'none' ? 'vs —' : c.key === 'prior' ? 'vs prior' : 'vs last yr'}
          </button>
        ))}
      </div>
    </div>
  );
}
