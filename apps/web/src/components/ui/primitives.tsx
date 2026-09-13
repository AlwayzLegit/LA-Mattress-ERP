'use client';

import Link from 'next/link';
import { forwardRef, useId, type ReactNode } from 'react';

import { cx } from './cx';

/**
 * Layout + form primitives over the design tokens in globals.css.
 * Pages adopt these instead of bespoke inline styles; anything not
 * covered can still pass `style`/`className` through. Buttons, chips,
 * dialogs, tables and the loading / empty / error states live in their
 * own files beside this one; `index.tsx` re-exports the whole kit.
 */

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input(props, ref) {
    return <input {...props} ref={ref} className={cx('input', props.className)} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select(props, ref) {
    return <select {...props} ref={ref} className={cx('select', props.className)} />;
  },
);

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
  style,
  as = 'label',
}: {
  label: ReactNode;
  /** Muted helper text under the control. */
  hint?: ReactNode;
  /** Inline validation message; also marks the field invalid. */
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /**
   * Render as a `<div>` (labelled via aria-labelledby) when the control hosts
   * nested interactive elements — e.g. a popover date-range picker.
   */
  as?: 'label' | 'div';
}) {
  const labelId = useId();
  const Tag = as;
  return (
    <Tag
      className={cx('field', error ? 'field-invalid' : undefined, className)}
      style={style}
      {...(as === 'div' ? { role: 'group', 'aria-labelledby': labelId } : {})}
    >
      <span className="field-label" id={as === 'div' ? labelId : undefined}>
        {label}
        {required && (
          <span className="field-required" aria-hidden>
            {' '}
            *
          </span>
        )}
      </span>
      {children}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </Tag>
  );
}

export function Card({
  title,
  description,
  children,
  actions,
  flush,
  className,
  style,
  ...rest
}: {
  title?: ReactNode;
  /** One muted line under the title explaining what the card holds. */
  description?: ReactNode;
  actions?: ReactNode;
  /** No inner padding — for a card that is just a table (`<TableWrap>`). */
  flush?: boolean;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div {...rest} className={cx('card', flush && 'card-flush', className)} style={style}>
      {(title || actions || description) && (
        <div className="card-header">
          <div className="card-header-main">
            {title && <h3 className="card-title">{title}</h3>}
            {description && <p className="card-desc">{description}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * THE page title. Every routed page renders exactly one of these as its
 * first child: eyebrow (BackLink / Breadcrumbs) → title row (title, meta
 * badges, right-aligned actions) → sub. Fixed rhythm: 24px below the
 * whole block; sub sits 4px under the title. Never hand-roll an <h1>.
 */
export function PageHeader({
  title,
  sub,
  actions,
  eyebrow,
  meta,
  className,
  ...rest
}: {
  title: ReactNode;
  /** One line under the title: "Customer since …", record counts, etc. */
  sub?: ReactNode;
  /** Right-aligned controls: ONE primary button + secondaries/pickers. */
  actions?: ReactNode;
  /** Row above the title: `<BackLink>` or `<Breadcrumbs>`. */
  eyebrow?: ReactNode;
  /** Inline after the title: a status badge, an "imported" chip. */
  meta?: ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <header {...rest} className={cx('page-head', className)}>
      {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
      <div className="page-header">
        <h1 className="page-title">
          {title}
          {meta && <span className="page-title-meta">{meta}</span>}
        </h1>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      {sub && <p className="page-sub">{sub}</p>}
    </header>
  );
}

/** "← All customers" — the eyebrow of a detail page that has one parent. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="back-link">
      <span aria-hidden>←</span> {children}
    </Link>
  );
}

/** Eyebrow for nested records: Orders / SO-1042. Last item is the current page. */
export function Breadcrumbs({ items }: { items: { label: ReactNode; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="breadcrumbs">
      {items.map((item, i) => (
        <span key={i} className="breadcrumb">
          {i > 0 && (
            <span className="breadcrumb-sep" aria-hidden>
              /
            </span>
          )}
          {item.href && i < items.length - 1 ? (
            <Link href={item.href}>{item.label}</Link>
          ) : (
            <span aria-current={i === items.length - 1 ? 'page' : undefined}>{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * The one heading for a section INSIDE a page (an h2 unless `as` says
 * otherwise): 24px above, 12px below, optional description and a
 * right-aligned action. Replaces ad-hoc <h2>/<h3> with inline styles and
 * the "muted uppercase" label pattern.
 */
export function SectionHeading({
  title,
  description,
  actions,
  as: Tag = 'h2',
  className,
  ...rest
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  as?: 'h2' | 'h3';
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div
      {...rest}
      className={cx('section-heading', Tag === 'h3' && 'section-heading-sm', className)}
    >
      <div className="section-heading-main">
        <Tag className="section-title">{title}</Tag>
        {description && <p className="section-desc">{description}</p>}
      </div>
      {actions && <div className="section-actions">{actions}</div>}
    </div>
  );
}

/** Vertical rhythm: children stacked with a fixed gap (16 default). */
export function Stack({
  gap = 'md',
  className,
  children,
  ...rest
}: {
  gap?: 'sm' | 'md' | 'lg';
  className?: string;
  children: ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx('stack', gap !== 'md' && `stack-${gap}`, className)}>
      {children}
    </div>
  );
}

/** Filter/search row above a list: wraps, 8px gaps, 16px below. */
export function Toolbar({
  className,
  children,
  end,
  align = 'center',
  ...rest
}: {
  className?: string;
  children: ReactNode;
  /** Controls pushed to the right edge (sort, export, counts). */
  end?: ReactNode;
  /** `end` aligns control bottoms so a button sits level with a labelled Field. */
  align?: 'center' | 'end';
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx('toolbar', align === 'end' && 'toolbar-align-end', className)}>
      {children}
      {end && <div className="toolbar-end">{end}</div>}
    </div>
  );
}

/** Responsive field grid for data entry: 1 col on phones, 2 (or 3) up. */
export function FormGrid({
  cols = 2,
  className,
  children,
  ...rest
}: {
  cols?: 1 | 2 | 3;
  className?: string;
  children: ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx('form-grid', `form-grid-${cols}`, className)}>
      {children}
    </div>
  );
}

/** Button row that closes a form: right-aligned, rule above. */
export function FormActions({
  className,
  children,
  start,
  ...rest
}: {
  className?: string;
  children: ReactNode;
  /** Left-side content (a destructive button, a "Saved." note). */
  start?: ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx('form-actions', className)}>
      {start && <div className="form-actions-start">{start}</div>}
      <div className="form-actions-end">{children}</div>
    </div>
  );
}

/** KPI row: 2 tiles on phones, `cols` from the md breakpoint. */
export function StatGrid({
  cols = 4,
  className,
  children,
  ...rest
}: {
  cols?: 2 | 3 | 4 | 5 | 6;
  className?: string;
  children: ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx('stat-grid', `stat-grid-${cols}`, className)}>
      {children}
    </div>
  );
}

export function StatTile({
  label,
  value,
  sub,
  tone,
  href,
  className,
  ...rest
}: {
  label: ReactNode;
  value: ReactNode;
  /** Small secondary line (delta, count, "of 12"). */
  sub?: ReactNode;
  tone?: 'success' | 'warning' | 'danger' | 'brand';
  /** Makes the whole tile a link to the screen behind the number. */
  href?: string;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  const body = (
    <>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </>
  );
  const cls = cx('stat-tile', tone && `stat-tile-${tone}`, href && 'stat-tile-link', className);
  if (href) {
    return (
      <Link {...(rest as React.HTMLAttributes<HTMLAnchorElement>)} href={href} className={cls}>
        {body}
      </Link>
    );
  }
  return (
    <div {...rest} className={cls}>
      {body}
    </div>
  );
}

/** Every `<table className="table">` lives inside one of these. */
export function TableWrap({
  className,
  children,
  maxHeight,
  style,
  ...rest
}: {
  className?: string;
  children: ReactNode;
  /** Scroll the body inside the wrap (pair with `table-sticky`). */
  maxHeight?: number | string;
  style?: React.CSSProperties;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cx('table-wrap', className)}
      style={maxHeight != null ? { maxHeight, overflowY: 'auto', ...style } : style}
    >
      {children}
    </div>
  );
}

/** Empty row inside a table body — keeps the header, says why it's empty. */
export function TableEmpty({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="table-empty">
        {children}
      </td>
    </tr>
  );
}

/** Label/value rows for detail cards (customer, money, addresses). */
export function KeyValue({
  rows,
  className,
  ...rest
}: {
  rows: { label: ReactNode; value: ReactNode }[];
  className?: string;
} & React.HTMLAttributes<HTMLDListElement>) {
  return (
    <dl {...rest} className={cx('kv', className)}>
      {rows.map((r, i) => (
        <div key={i} className="kv-row">
          <dt className="kv-label">{r.label}</dt>
          <dd className="kv-value">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Inline notice (page-level error, success, info) over the `.alert` kit. */
export function Alert({
  tone = 'info',
  title,
  action,
  children,
  className,
  ...rest
}: {
  tone?: 'info' | 'success' | 'warning' | 'error';
  title?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div
      {...rest}
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx('alert', `alert-${tone}`, className)}
    >
      <div>
        {title && <div className="alert-title">{title}</div>}
        {children}
      </div>
      {action && <div className="alert-action">{action}</div>}
    </div>
  );
}

/**
 * Collapsible section for long grouped content (permission editors,
 * settings sheets). Header carries a title on the left and an optional
 * summary (counts, badges) next to the chevron; `leading` renders before
 * the title and outside the toggle button so it can hold its own
 * interactive control (e.g. a select-all checkbox).
 */
export function Accordion({
  title,
  summary,
  leading,
  open,
  onToggle,
  children,
}: {
  title: ReactNode;
  summary?: ReactNode;
  leading?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--surface)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
        }}
      >
        {leading}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            textAlign: 'left',
            color: 'var(--text)',
            font: 'inherit',
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 13 }}>{title}</span>
          <span style={{ flex: 1 }} />
          {summary && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{summary}</span>}
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              transition: 'transform 0.15s',
              transform: open ? 'rotate(90deg)' : 'none',
              color: 'var(--text-muted)',
              fontSize: 12,
            }}
          >
            ▶
          </span>
        </button>
      </div>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '10px 12px' }}>{children}</div>
      )}
    </div>
  );
}
