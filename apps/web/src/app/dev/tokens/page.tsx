import type { Metadata } from 'next';
import type { CSSProperties, ReactNode } from 'react';
import {
  ACCENTS,
  DENSITIES,
  NEUTRALS,
  RADII,
  SPACE_SCALE,
  STATUSES,
  TYPE_SCALE,
} from '@/lib/design-tokens';

export const metadata: Metadata = {
  title: 'Tokens · LA Mattress ERP',
  robots: { index: false, follow: false },
};

/**
 * `/dev/tokens` — the token sheet from canvas `Redesign 2 System.dc.html`
 * artboard 2d, rendered from the live CSS variables so a wrong value in
 * `globals.css` shows up here first. Static, no data, no shell.
 */
export default function TokensPage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--bg)',
        padding: '40px clamp(16px, 4vw, 56px) 64px',
      }}
    >
      <div style={{ maxWidth: 1328, margin: '0 auto' }}>
        <header style={{ marginBottom: 32 }}>
          <div className="t-mono-sm" style={{ color: 'var(--muted)', letterSpacing: '0.04em' }}>
            LA MATTRESS ERP · REDESIGN · PHASE 1
          </div>
          <h1 className="t-display-l" style={{ margin: '6px 0 0' }}>
            Tokens
          </h1>
          <p className="t-body" style={{ color: 'var(--muted)', margin: '6px 0 0', maxWidth: 640 }}>
            Neutral ramp with a warm (paper) bias, one accent, six statuses that read without
            colour. Values are literal; nothing is computed. Light mode only.
          </p>
        </header>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
            gap: '36px 48px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            padding: 'clamp(20px, 3vw, 40px) clamp(20px, 3vw, 56px)',
          }}
        >
          <Section label="Type scale · Public Sans / Archivo / JetBrains Mono">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {TYPE_SCALE.map((t) => (
                <div
                  key={t.token}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '150px minmax(0, 1fr)',
                    alignItems: 'baseline',
                    gap: 12,
                  }}
                >
                  <Mono>{t.token}</Mono>
                  <div style={{ minWidth: 0 }}>
                    <div className={t.className} style={{ whiteSpace: 'nowrap' }}>
                      {t.sample}
                    </div>
                    <div className="t-mono-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>
                      {t.family} · {t.size} / {t.weight} · lh {t.lineHeight}
                      {t.letterSpacing !== '0' ? ` · ls ${t.letterSpacing}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          <div>
            <Section label="Neutral ramp · warm bias">
              <Swatches items={NEUTRALS} />
            </Section>
            <Section label="Accent · one" style={{ marginTop: 24 }}>
              <Swatches items={ACCENTS} />
            </Section>
            <Section label="Destructive tier" style={{ marginTop: 24 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-primary">
                  Complete sale
                </button>
                <button type="button" className="btn btn-secondary">
                  Print
                </button>
                <button type="button" className="btn btn-ghost">
                  More
                </button>
                <span style={{ flex: '1 0 24px' }} />
                <button type="button" className="btn btn-danger">
                  Cancel order
                </button>
              </div>
              <p className="t-body" style={{ color: 'var(--text-2)', margin: '10px 0 0' }}>
                Outlined <Mono>#b3261e</Mono> on white, never filled, never adjacent to primary,
                never default focus. Tab through the row to see the focus ring.
              </p>
            </Section>
          </div>

          <div>
            <Section label="Status · colour + glyph + word, always together">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {STATUSES.map((s) => (
                  <div
                    key={s.key}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '170px minmax(0, 1fr)',
                      alignItems: 'center',
                      gap: 12,
                      fontSize: 12.5,
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 9px 3px 7px',
                        border: `1px solid var(--status-${s.key}-border)`,
                        background: `var(--status-${s.key}-bg)`,
                        color: `var(--status-${s.key}-fg)`,
                        borderRadius: 'var(--radius-chip)',
                        fontWeight: 600,
                        fontSize: 11.5,
                        width: 'fit-content',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <span aria-hidden className="t-mono-sm" style={{ lineHeight: 1 }}>
                        {s.glyph}
                      </span>
                      <span style={{ textDecoration: s.strike ? 'line-through' : 'none' }}>
                        {s.label}
                      </span>
                    </span>
                    <span style={{ color: 'var(--text-2)' }}>
                      <Mono>{s.fg}</Mono> on <Mono>{s.bg}</Mono> · {s.ratio} · {s.when}
                    </span>
                  </div>
                ))}
              </div>
            </Section>

            <Section label="Spacing · radius · density" style={{ marginTop: 24 }}>
              <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.8 }}>
                <Row k="space">
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'flex-end' }}>
                    {SPACE_SCALE.map((n) => (
                      <span key={n} style={{ display: 'inline-flex', flexDirection: 'column' }}>
                        <span
                          aria-hidden
                          style={{ width: n, height: n, background: 'var(--accent-soft)' }}
                        />
                        <Mono>{n}</Mono>
                      </span>
                    ))}
                  </span>
                </Row>
                <Row k="radius">
                  {RADII.map((r, i) => (
                    <span key={r.token}>
                      {i > 0 ? ' · ' : ''}
                      {r.px} ({r.use})
                    </span>
                  ))}
                </Row>
                {DENSITIES.map((d) => (
                  <Row key={d.key} k={d.key}>
                    row {d.row}px · text {d.text}px · control {d.control}px
                    {d.key === 'register' ? ` · hit target ≥ ${d.hit}px` : ''}
                  </Row>
                ))}
                <Row k="focus">2px #1e3a5f outline, 2px offset, never removed</Row>
                <Row k="motion">
                  120ms ease-out for state (add line, chip change, slide-over 160ms); 0ms under
                  prefers-reduced-motion; nothing loops but the skeleton
                </Row>
              </div>
            </Section>
          </div>

          <Section label="Density presets · data-density" style={{ gridColumn: '1 / -1' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                gap: 24,
              }}
            >
              {DENSITIES.map((d) => (
                <div key={d.key} data-density={d.key}>
                  <div className="t-label" style={{ marginBottom: 8 }}>
                    {d.key}
                  </div>
                  <DensityDemo />
                </div>
              ))}
            </div>
          </Section>

          <Section label="Skeleton · 1.4s shimmer, static two-tone under reduced motion">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[180, 320, 260].map((w) => (
                <div key={w} className="skeleton" style={{ height: 12, width: w }} />
              ))}
              <div className="t-body" style={{ color: 'var(--muted)' }}>
                Skeleton becomes the error component after 4s (Phase 2).
              </div>
            </div>
          </Section>
        </div>
      </div>
    </main>
  );
}

function Section({
  label,
  children,
  style,
}: {
  label: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section style={style}>
      <h2
        className="t-mono-sm"
        style={{
          margin: '0 0 10px',
          color: 'var(--muted)',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          fontWeight: 400,
        }}
      >
        {label}
      </h2>
      {children}
    </section>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <span className="t-mono-sm" style={{ color: 'var(--text)' }}>
      {children}
    </span>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px minmax(0, 1fr)', gap: 12 }}>
      <Mono>{k}</Mono>
      <span>{children}</span>
    </div>
  );
}

function Swatches({
  items,
}: {
  items: { token: string; cssVar: string; hex: string; use: string }[];
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map((c) => (
        <div
          key={c.token}
          style={{
            display: 'grid',
            gridTemplateColumns: '36px 130px minmax(0, 1fr)',
            alignItems: 'center',
            gap: 12,
            fontSize: 12.5,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 36,
              height: 26,
              background: `var(${c.cssVar})`,
              border: '1px solid var(--border)',
            }}
          />
          <Mono>{c.token}</Mono>
          <span style={{ color: 'var(--text-2)' }}>
            {c.hex} · {c.use}
          </span>
        </div>
      ))}
    </div>
  );
}

/** One table row + one control at the ambient density. */
function DensityDemo() {
  return (
    <div style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 90px 110px',
          alignItems: 'center',
          height: 'var(--row-h)',
          padding: '0 12px',
          borderBottom: '1px solid var(--border)',
          fontSize: 'var(--text-size)',
        }}
      >
        <span>
          Cloud Comfort Mattress, Queen{' '}
          <span className="t-mono-sm" style={{ color: 'var(--muted)' }}>
            CCM-Q
          </span>
        </span>
        <span className="t-mono" style={{ textAlign: 'right' }}>
          1
        </span>
        <span className="t-mono" style={{ textAlign: 'right' }}>
          $1,299.00
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, padding: 12, alignItems: 'center' }}>
        <label className="field" style={{ flex: 1 }}>
          <span className="field-label">Customer</span>
          <input
            className="input"
            defaultValue="Search name or phone"
            style={{ height: 'var(--control-h)', width: '100%' }}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          style={{ height: 'var(--control-h)', minWidth: 'var(--hit-target)', marginTop: 20 }}
        >
          Add product
        </button>
      </div>
      <div className="t-mono-sm" style={{ padding: '0 12px 10px', color: 'var(--muted)' }}>
        row var(--row-h) · text var(--text-size) · control var(--control-h)
      </div>
    </div>
  );
}
