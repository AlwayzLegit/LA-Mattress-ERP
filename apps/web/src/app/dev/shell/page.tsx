'use client';

import { useState } from 'react';
import { Button, ErrorState, Kbd, Skeleton } from '@/components/ui';
import { noteFailure, noteSuccess } from '@/lib/api-status';
import { navFor } from '@/components/shell/nav';
import { ShellError } from '@/components/shell/shell-error';
import { Sidebar } from '@/components/shell/sidebar';

/**
 * `/dev/shell` — the shell frame from canvas 3a–3e rendered with the
 * real sidebar, topbar classes and error component, on mock data and
 * with no session, so the chrome can be checked at 1440 and 1280
 * without signing in. Toggle role, loading and error below.
 */
const COUNTS: Record<string, number> = {
  '/orders': 31,
  '/deliveries': 14,
  '/jeopardy': 4,
  '/tasks': 3,
};

export default function ShellPreview() {
  const [role, setRole] = useState<'Owner' | 'Cashier'>('Owner');
  const [state, setState] = useState<'normal' | 'loading' | 'error'>('normal');
  const groups = navFor(role, []);
  const cashier = role === 'Cashier';

  const setMode = (m: typeof state) => {
    setState(m);
    if (m === 'error') noteFailure('503 Service Unavailable');
    else noteSuccess();
  };

  return (
    <div className="min-h-screen" data-density={cashier ? 'register' : undefined}>
      <aside className="app-sidebar fixed inset-y-0 left-0 z-40 flex w-[var(--sidebar-width)] flex-col overflow-y-auto">
        <Sidebar
          groups={groups}
          counts={(href) =>
            cashier ? Math.ceil((COUNTS[href] ?? 0) / 5) || null : (COUNTS[href] ?? null)
          }
          userKey="preview"
          onShortcuts={() => undefined}
        />
      </aside>
      <div className="app-main ml-[var(--sidebar-width)]">
        <header className="app-topbar">
          <div className="acting">
            <button
              type="button"
              className="acting-chip"
              title="Every sale, drawer and report on this screen is for this store"
            >
              <span className="acting-glyph" aria-hidden>
                ⌂
              </span>
              <span className="acting-text">
                Acting for <strong>Glendale</strong>
              </span>
              <span className="acting-caret" aria-hidden>
                ▾
              </span>
            </button>
          </div>
          {!cashier && (
            <div className="seg seg-lg" role="tablist" aria-label="Dashboard view">
              {['Owner', 'Manager', 'Operations', 'Warehouse'].map((r, i) => (
                <button
                  key={r}
                  type="button"
                  role="tab"
                  aria-selected={i === 0}
                  className={`seg-btn${i === 0 ? ' is-active' : ''}`}
                >
                  {r}
                </button>
              ))}
            </div>
          )}
          <button type="button" className="topbar-search">
            <span aria-hidden className="topbar-search-glyph">
              ⌕
            </span>
            <span className="topbar-search-text">Search orders, customers, SKUs…</span>
            <Kbd keys="mod+k" />
          </button>
          <div className="topbar-end">
            <button type="button" className="topbar-icon" aria-label="Inbox, 3 unread">
              <span aria-hidden>◔</span>
              <span className="unread-badge">3</span>
            </button>
            <Button variant="primary" kbd="n">
              New sale
            </Button>
            <button type="button" className="topbar-btn">
              <span
                aria-hidden
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  background: 'var(--accent-soft)',
                  color: 'var(--accent)',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 10,
                  fontWeight: 600,
                }}
              >
                {cashier ? 'AR' : 'AL'}
              </span>
              {cashier ? 'Arman' : 'Alex'}
              <span style={{ color: 'var(--muted)', fontSize: 10 }}>▾</span>
            </button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1560px] px-[22px] pb-12 pt-[22px]">
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              marginBottom: 16,
              padding: 8,
              border: '1px dashed var(--border)',
              borderRadius: 5,
              fontSize: 12.5,
              color: 'var(--muted)',
            }}
          >
            <span className="t-mono-sm">PREVIEW CONTROLS</span>
            <div className="seg">
              {(['Owner', 'Cashier'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`seg-btn${role === r ? ' is-active' : ''}`}
                  onClick={() => setRole(r)}
                >
                  {r}
                </button>
              ))}
            </div>
            <div className="seg">
              {(['normal', 'loading', 'error'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`seg-btn${state === m ? ' is-active' : ''}`}
                  onClick={() => setMode(m)}
                >
                  {m}
                </button>
              ))}
            </div>
            <span style={{ marginLeft: 'auto' }}>
              Sidebar {cashier ? '200px · 1280 register' : '220px · 1440 owner'}
            </span>
          </div>

          <ShellError />

          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 16 }}>
            <div>
              <div className="t-label" style={{ marginBottom: 4 }}>
                Sell · Glendale
              </div>
              <h1 className="t-heading" style={{ margin: 0, fontSize: 22 }}>
                New sale
              </h1>
            </div>
            <div style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--muted)' }}>
              {state === 'loading' ? (
                <>
                  Connecting to the register… <span className="mono">2s</span>
                </>
              ) : (
                <>
                  Draft <span className="mono">SO-10441</span> · saves as you type
                </>
              )}
            </div>
          </div>

          {state === 'error' ? (
            <ErrorState title="Register content and totals rail arrive in Phase 4">
              The shell-level error above is the component from canvas 3d; the page below it keeps
              rendering so the sidebar and the store context never disappear.
            </ErrorState>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) 316px',
                gap: 16,
                alignItems: 'start',
              }}
            >
              <div className="card" style={{ minHeight: 280 }}>
                {state === 'loading' ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {[220, 420, 380, 300, 460, 240].map((w) => (
                      <Skeleton key={w} style={{ height: 12, width: w }} />
                    ))}
                  </div>
                ) : (
                  <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                    register content · Phase 4
                  </div>
                )}
              </div>
              <div className="card" style={{ minHeight: 280 }}>
                {state === 'loading' ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {[140, 200, 180, 120].map((w) => (
                      <Skeleton key={w} style={{ height: 12, width: w }} />
                    ))}
                  </div>
                ) : (
                  <div style={{ color: 'var(--muted)', fontSize: 13 }}>totals rail · Phase 4</div>
                )}
              </div>
            </div>
          )}
          {state === 'loading' && (
            <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 12 }}>
              Shortcuts and the sidebar work while this loads. If nothing arrives in 4 seconds this
              becomes the error state — never a bare “Loading…”.
            </p>
          )}
        </main>
      </div>
    </div>
  );
}
