'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Button } from './button';
import { cx } from './cx';

/** Loading budget before a skeleton hands off to the error component. */
export const LOAD_BUDGET_MS = 4000;

export function Skeleton({
  style,
  className,
  ...rest
}: { style?: React.CSSProperties; className?: string } & Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'title'
>) {
  return <div {...rest} aria-hidden className={cx('skeleton', className)} style={style} />;
}

/**
 * `true` once `loading` has been continuously true for `budgetMs`. Resets
 * when loading stops (a retry restarts the clock).
 */
export function useLoadBudget(loading: boolean, budgetMs = LOAD_BUDGET_MS): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!loading) {
      setOver(false);
      return;
    }
    const t = window.setTimeout(() => setOver(true), budgetMs);
    return () => window.clearTimeout(t);
  }, [loading, budgetMs]);
  return over;
}

/**
 * Error with retry (canvas 2e): names what failed and what happens next.
 * `retryIn` counts down and calls `onRetry` at zero (auto-retry); the
 * manual button is always there.
 */
export function ErrorState({
  title,
  children,
  onRetry,
  retryIn,
  retryLabel = 'Retry',
  className,
  ...rest
}: {
  title: ReactNode;
  /** One or two sentences: where the draft is, what to do. */
  children?: ReactNode;
  onRetry?: () => void;
  /** Seconds until an automatic retry; omit for manual only. */
  retryIn?: number;
  retryLabel?: string;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>) {
  const [left, setLeft] = useState(retryIn ?? 0);
  useEffect(() => {
    setLeft(retryIn ?? 0);
    if (!retryIn || !onRetry) return;
    const started = Date.now();
    const id = window.setInterval(() => {
      const remain = Math.max(0, retryIn - Math.floor((Date.now() - started) / 1000));
      setLeft(remain);
      if (remain === 0) {
        window.clearInterval(id);
        onRetry();
      }
    }, 250);
    return () => window.clearInterval(id);
    // Restart the countdown when the caller hands us a new budget.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryIn]);
  return (
    <div {...rest} role="alert" className={cx('error-state', className)}>
      <span className="error-state-glyph" aria-hidden>
        ▲
      </span>
      <div className="error-state-main">
        <div className="error-state-title">{title}</div>
        {children && <div className="error-state-text">{children}</div>}
        {onRetry && (
          <div className="error-state-actions">
            <Button size="sm" onClick={onRetry}>
              {retryLabel}
            </Button>
            {retryIn ? (
              <span className="error-state-countdown">
                {left > 0 ? `Retrying in ${left}s` : 'Retrying…'}
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Skeleton rows in final positions with the 4-second budget: past it the
 * rows become the error component with Retry. Pass `onRetry` so the
 * error can re-run the load; without it the timeout copy still names
 * the state instead of shimmering forever.
 */
export function LoadingRows({
  rows = 3,
  height = 32,
  budgetMs = LOAD_BUDGET_MS,
  onRetry,
  what = 'This list',
  label = 'Loading',
}: {
  rows?: number;
  height?: number;
  budgetMs?: number | null;
  onRetry?: () => void;
  /** Named in the timeout copy: "Orders is taking longer than it should." */
  what?: string;
  label?: string;
}) {
  const over = useLoadBudget(budgetMs != null, budgetMs ?? LOAD_BUDGET_MS);
  if (over) {
    return (
      <ErrorState title={`${what} is taking longer than it should`} onRetry={onRetry}>
        Nothing you typed is lost. Retry, or keep working — it will fill in when the server answers.
      </ErrorState>
    );
  }
  return (
    <div
      className="loading-rows"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
    >
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} style={{ height }} />
      ))}
    </div>
  );
}

/** Empty state (canvas 2e): dashed border, a title, one action. */
export function EmptyState({
  title,
  action,
  children,
  className,
  ...rest
}: {
  /** Short bold line; `children` is the explanation under it. */
  title?: ReactNode;
  /** One button — "Clear filters", "Schedule one". */
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div {...rest} className={cx('empty-state', className)}>
      {title && <div className="empty-state-title">{title}</div>}
      {children && <div className="empty-state-text">{children}</div>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
