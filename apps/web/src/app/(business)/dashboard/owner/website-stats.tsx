'use client';

import { useEffect, useState } from 'react';
import {
  WEBSITE_STATS_SECTIONS,
  type StatsCard,
  type StatsFormat,
  type StatsTable,
  type StatsValue,
  type WebsiteStatsReport,
  type WebsiteStatsSection,
} from '@jetnine/shared';
import { apiUrl } from '@/lib/api';
import styles from './website-stats.module.css';

export function formatWebsiteStat(
  value: StatsValue,
  format: StatsFormat,
  currency = 'USD',
): string {
  if (value === null) return '—';
  if (typeof value === 'string') {
    if (format === 'date' || format === 'datetime') {
      const date = new Date(format === 'date' ? value + 'T12:00:00Z' : value);
      if (!Number.isNaN(date.getTime()))
        return date.toLocaleString('en-US', {
          timeZone: format === 'date' ? 'UTC' : 'America/Los_Angeles',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          ...(format === 'datetime'
            ? { hour: 'numeric' as const, minute: '2-digit' as const }
            : {}),
        });
    }
    return value;
  }
  if (format === 'money')
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value / 100);
  if (format === 'ratio' || format === 'percent')
    return `${(format === 'ratio' ? value * 100 : value).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
  if (format === 'milliseconds')
    return `${(value / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}s`;
  if (format === 'seconds')
    return `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })}s`;
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function StatsGrid({ table }: { table: StatsTable }) {
  return (
    <details className={styles.detail} open={table.rows.length <= 10}>
      <summary>
        {table.title} <span>({table.rows.length})</span>
      </summary>
      {table.rows.length === 0 ? (
        <p className={styles.note}>No records in this source window.</p>
      ) : (
        <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={table.title}>
          <table>
            <caption className="sr-only">{table.title}</caption>
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th key={c.key} scope="col">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={i}>
                  {table.columns.map((c) => (
                    <td
                      key={c.key}
                      className={
                        !['text', 'date', 'datetime'].includes(c.format)
                          ? styles.numeric
                          : undefined
                      }
                    >
                      {formatWebsiteStat(
                        row[c.key] ?? null,
                        c.format,
                        typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency)
                          ? row.currency
                          : 'USD',
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
function RevenueTrend({ table }: { table: StatsTable }) {
  const rows = table.rows.filter((row) => typeof row.revenue === 'number');
  if (!rows.length) return null;
  const max = Math.max(1, ...rows.map((row) => row.revenue as number));
  return (
    <figure className={styles.trend}>
      <figcaption>
        Daily website revenue <span>· exact values in the table below</span>
      </figcaption>
      <div className={styles.bars} aria-hidden="true">
        {rows.map((row, i) => (
          <div
            key={i}
            title={`${row.date}: ${formatWebsiteStat(row.revenue ?? null, 'money')}`}
            style={{ height: `${Math.max(1, ((row.revenue as number) / max) * 100)}%` }}
          />
        ))}
      </div>
      <div className={styles.trendDates}>
        <span>{rows[0]?.date}</span>
        <span>{rows[rows.length - 1]?.date}</span>
      </div>
    </figure>
  );
}
function WebsiteCard({ card }: { card: StatsCard }) {
  const daily = card.tables.find((t) => t.title === 'Daily revenue');
  return (
    <article className={styles.card} aria-labelledby={`website-card-${card.id}`}>
      <div className={styles.cardHead}>
        <h4 id={`website-card-${card.id}`}>{card.title}</h4>
        <span>{card.source}</span>
      </div>
      {card.status !== 'ready' ? (
        <p className={styles.unavailable}>
          {card.status === 'unconfigured'
            ? `${card.source} is not connected on the website.`
            : `${card.source} data is temporarily unavailable.`}
        </p>
      ) : (
        <>
          {card.metrics.length > 0 && (
            <dl className={styles.metrics}>
              {card.metrics.map((metric) => (
                <div key={metric.label}>
                  <dt>{metric.label}</dt>
                  <dd>{formatWebsiteStat(metric.value, metric.format, metric.currency)}</dd>
                  {metric.previous !== undefined && (
                    <p className={styles.previous}>
                      Prior: {formatWebsiteStat(metric.previous, metric.format, metric.currency)}
                    </p>
                  )}
                </div>
              ))}
            </dl>
          )}
          {daily && <RevenueTrend table={daily} />}
          {card.tables.map((table) => (
            <StatsGrid key={table.title} table={table} />
          ))}
        </>
      )}
      {card.note && <p className={styles.note}>{card.note}</p>}
    </article>
  );
}
/** Isolated source request: website downtime must not mark the ERP sales service offline. */
export function WebsiteStatsPanel({ businessId }: { businessId: string }) {
  const [section, setSection] = useState<WebsiteStatsSection>('overview');
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [revision, setRevision] = useState(0);
  const [report, setReport] = useState<WebsiteStatsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 50_000);
    let current = true;
    setReport(null);
    setError(null);
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch(
          `${apiUrl}/v1/dashboard/website?section=${section}&days=${days}`,
          {
            credentials: 'include',
            headers: { 'x-business-id': businessId },
            signal: controller.signal,
            cache: 'no-store',
          },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { message?: string } | null;
          throw new Error(
            response.status === 403
              ? 'Website statistics are available to the owner.'
              : response.status === 401
                ? 'Your session has expired. Sign in again to view website statistics.'
                : body?.message === 'Website statistics are not connected for this business.'
                  ? 'Website statistics have not been connected for this business yet.'
                  : 'Website statistics could not be loaded. Your ERP sales dashboard is still available.',
          );
        }
        const result = (await response.json()) as WebsiteStatsReport;
        if (
          result.version !== 1 ||
          result.businessId !== businessId ||
          result.days !== days ||
          result.section !== section
        )
          throw new Error('The website returned an unexpected report. Please retry.');
        if (current) setReport(result);
      } catch (err) {
        if (current)
          setError(
            controller.signal.aborted
              ? 'The website took too long to respond. Please retry.'
              : err instanceof Error
                ? err.message
                : 'Website statistics are unavailable.',
          );
      } finally {
        clearTimeout(timeout);
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [businessId, section, days, revision]);
  const selected = WEBSITE_STATS_SECTIONS.find((s) => s.id === section)!;
  const adminPath = section === 'overview' ? '/admin' : `/admin/${section}`;
  const adminQuery = section === 'store-actions' ? `days=${days}` : `range=${days}d&compare=1`;
  return (
    <section
      className={styles.website}
      aria-labelledby="website-stats-title"
      data-testid="website-statistics"
    >
      <div className={styles.header}>
        <div>
          <div className={styles.eyebrow}>Online business</div>
          <h2 id="website-stats-title">Website statistics</h2>
          <p>
            mattressstoreslosangeles.com · Sitewide, independent of the store and sales filters
            above.
          </p>
        </div>
        <div className={styles.controls}>
          <label>
            Website period{' '}
            <select
              aria-label="Website period"
              value={days}
              onChange={(e) => setDays(Number(e.target.value) as 7 | 30 | 90)}
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </label>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            disabled={loading}
            onClick={() => setRevision((v) => v + 1)}
          >
            Refresh website
          </button>
          <a
            className="btn btn-secondary btn-sm"
            href={`https://mattressstoreslosangeles.com${adminPath}?${adminQuery}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Website admin ↗
          </a>
        </div>
      </div>
      <nav className={styles.sections} aria-label="Website report sections">
        {WEBSITE_STATS_SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={s.id === section}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className={styles.reportHeading}>
        <h3>{selected.label}</h3>
        <span>
          {report
            ? `Updated ${new Date(report.generatedAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} PT · cached up to 1 minute`
            : `Last ${days} days`}
        </span>
      </div>
      <div aria-live="polite">
        {loading && (
          <div className={styles.loading} role="status">
            Loading {selected.label.toLowerCase()} statistics…
          </div>
        )}
        {error && (
          <div className={styles.error} role="alert">
            <span>{error}</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setRevision((v) => v + 1)}
            >
              Retry website
            </button>
          </div>
        )}
      </div>
      {report &&
        report.section === section &&
        report.days === days &&
        report.businessId === businessId && (
          <div className={styles.cards}>
            {report.cards.map((card) => (
              <WebsiteCard key={card.id} card={card} />
            ))}
          </div>
        )}
    </section>
  );
}
