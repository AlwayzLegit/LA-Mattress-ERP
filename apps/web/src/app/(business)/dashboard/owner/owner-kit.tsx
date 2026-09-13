'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Pieces every redesigned home shares (Claude Design hand-off,
 * 2026-09-04): the KPI strip, the panel frame, status pills, money
 * formatting in the design's whole-dollar / "$18.9k" styles, and the
 * per-card customize handle.
 */

export function usdWhole(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}

export function usdShort(cents: number): string {
  const d = cents / 100;
  if (Math.abs(d) >= 1000) return `$${(d / 1000).toFixed(Math.abs(d) >= 100_000 ? 0 : 1)}k`;
  return `$${Math.round(d).toLocaleString('en-US')}`;
}

/** "+12%" / "−4%" against a base; null when there is no base. */
export function pctDelta(now: number, base: number): string | null {
  if (!base) return null;
  const p = Math.round(((now - base) / base) * 100);
  return `${p >= 0 ? '+' : '−'}${Math.abs(p)}%`;
}

export function shortDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export type Tone = 'muted' | 'ok' | 'info' | 'warn' | 'danger';

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`pill-status tone-${tone}`}>{children}</span>;
}

export function orderStatusMeta(status: string): { label: string; tone: Tone } {
  switch (status) {
    case 'draft':
      return { label: 'Draft', tone: 'muted' };
    case 'quote':
      return { label: 'Quote', tone: 'warn' };
    case 'open':
      return { label: 'Open', tone: 'info' };
    case 'fulfilled':
      return { label: 'Fulfilled', tone: 'ok' };
    case 'completed':
      return { label: 'Completed', tone: 'muted' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'danger' };
    default:
      return { label: status.replace(/_/g, ' '), tone: 'muted' };
  }
}

export interface KpiTile {
  key: string;
  label: string;
  value: ReactNode;
  delta?: string | null;
  deltaTone?: 'up' | 'down';
  sub: string;
  href: string;
  tone?: 'danger';
  /** 0–100 progress bar under the tile. */
  barPct?: number;
  testid?: string;
}

export function KpiStrip({ tiles, loading }: { tiles: KpiTile[]; loading?: boolean }) {
  return (
    <div className="kpi-strip" data-testid="kpi-row">
      {tiles.map((k) => (
        <Link key={k.key} href={k.href} className="kpi-cell" data-testid={k.testid}>
          <div className="kpi-label">
            <span>{k.label}</span>
            <span style={{ color: 'var(--faint)' }}>↗</span>
          </div>
          {loading ? (
            <div className="shimmer" style={{ height: 'var(--kpi)', width: '70%' }} />
          ) : (
            <div
              className="kpi-value"
              style={{ color: k.tone === 'danger' ? 'var(--danger)' : 'var(--text)' }}
            >
              {k.value}
            </div>
          )}
          <div className="kpi-sub">
            {k.delta && (
              <span
                className="kpi-delta"
                style={{ color: k.deltaTone === 'down' ? 'var(--danger)' : 'var(--accent-ink)' }}
              >
                {k.delta}
              </span>
            )}
            <span>{k.sub}</span>
          </div>
          {k.barPct != null && (
            <div className="meter">
              <span style={{ width: `${Math.max(0, Math.min(100, k.barPct))}%` }} />
            </div>
          )}
        </Link>
      ))}
    </div>
  );
}

export function Panel({
  title,
  sub,
  link,
  actions,
  children,
  style,
  clip = true,
  testid,
  className,
}: {
  title: ReactNode;
  sub?: ReactNode;
  link?: { href: string; label: string };
  actions?: ReactNode;
  children: ReactNode;
  style?: React.CSSProperties;
  clip?: boolean;
  testid?: string;
  className?: string;
}) {
  return (
    <section
      className={`panel${clip ? ' panel-clip' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      data-testid={testid}
    >
      <div className="panel-head">
        <h2>{title}</h2>
        {sub && <span className="panel-sub">{sub}</span>}
        {link && (
          <Link href={link.href} className="panel-link">
            {link.label} →
          </Link>
        )}
        {actions}
      </div>
      {children}
    </section>
  );
}

export function EmptyRow({ children, colSpan }: { children: ReactNode; colSpan?: number }) {
  const inner = (
    <div
      style={{
        padding: '28px var(--pad)',
        textAlign: 'center',
        color: 'var(--muted)',
        fontSize: 12.5,
      }}
    >
      {children}
    </div>
  );
  return colSpan ? (
    <tr>
      <td colSpan={colSpan} style={{ padding: 0 }}>
        {inner}
      </td>
    </tr>
  ) : (
    inner
  );
}

export function ShimmerRows({ rows = 5, colSpan }: { rows?: number; colSpan?: number }) {
  const widths = Array.from({ length: rows }, (_, i) => `${40 + ((i * 23) % 50)}%`);
  if (colSpan) {
    return (
      <>
        {widths.map((w, i) => (
          <tr key={i} aria-busy="true">
            <td colSpan={colSpan}>
              <div className="shimmer" style={{ height: 14, width: w }} />
            </td>
          </tr>
        ))}
      </>
    );
  }
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 'var(--pad)' }}
    >
      {widths.map((w, i) => (
        <div key={i} className="shimmer" style={{ height: 14, width: w }} />
      ))}
    </div>
  );
}

/** ▲ ▼ ⊘ controls shown on a card while the home is in customize mode. */
export function CardHandle({
  onUp,
  onDown,
  onHide,
  hidden,
}: {
  onUp: () => void;
  onDown: () => void;
  onHide: () => void;
  hidden: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: 3, marginLeft: 8 }} data-noprint="true">
      <button
        type="button"
        className="icon-btn"
        style={{ width: 24, height: 24, fontSize: 10 }}
        onClick={onUp}
        aria-label="Move up"
      >
        ▲
      </button>
      <button
        type="button"
        className="icon-btn"
        style={{ width: 24, height: 24, fontSize: 10 }}
        onClick={onDown}
        aria-label="Move down"
      >
        ▼
      </button>
      <button
        type="button"
        className="icon-btn"
        style={{ width: 24, height: 24, fontSize: 12 }}
        onClick={onHide}
        aria-label={hidden ? 'Show card' : 'Hide card'}
      >
        {hidden ? '◉' : '⊘'}
      </button>
    </div>
  );
}
