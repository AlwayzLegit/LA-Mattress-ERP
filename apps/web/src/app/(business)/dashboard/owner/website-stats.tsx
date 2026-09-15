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
    <details className={styles.detail}>
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
          {daily && (
            <details className={styles.detail}>
              <summary>Revenue chart</summary>
              <RevenueTrend table={daily} />
            </details>
          )}
          {card.tables.map((table) => (
            <StatsGrid key={table.title} table={table} />
          ))}
        </>
      )}
      {card.note && <p className={styles.note}>{card.note}</p>}
    </article>
  );
}
interface PinnedCard {
  section: WebsiteStatsSection;
  id: string;
  metrics: string[] | null;
  tables: boolean;
}
type Pins = Record<string, PinnedCard>;
const pinKey = (section: WebsiteStatsSection, id: string) => section + ':' + id;

/** Select only the website sections needed for this owner's dashboard. */
export function WebsiteStatsPanel({
  businessId,
  preferenceKey = 'jetnine.website.' + businessId,
}: {
  businessId: string;
  preferenceKey?: string;
}) {
  const [section, setSection] = useState<WebsiteStatsSection>('overview');
  const [choosing, setChoosing] = useState(false);
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [pins, setPins] = useState<Pins | null>(null);
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const [reports, setReports] = useState<Partial<Record<WebsiteStatsSection, WebsiteStatsReport>>>(
    {},
  );
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    setReady(false);
    try {
      const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? 'null') as {
        pins?: Pins;
        days?: number;
      } | null;
      const clean: Pins = {};
      if (saved?.pins && typeof saved.pins === 'object')
        for (const p of Object.values(saved.pins)) {
          if (
            p &&
            WEBSITE_STATS_SECTIONS.some((s) => s.id === p.section) &&
            typeof p.id === 'string'
          ) {
            clean[pinKey(p.section, p.id)] = {
              ...p,
              metrics: Array.isArray(p.metrics)
                ? p.metrics.filter((m) => typeof m === 'string')
                : null,
              tables: p.tables === true,
            };
          }
        }
      setPins(saved?.pins ? clean : null);
      setDays(saved?.days === 7 || saved?.days === 90 ? saved.days : 30);
    } catch {
      setPins(null);
    }
    setReady(true);
  }, [preferenceKey]);
  const save = (next: Pins | null, period = days) => {
    setPins(next);
    setDays(period);
    try {
      localStorage.setItem(preferenceKey, JSON.stringify({ pins: next, days: period }));
    } catch {
      /* browser storage may be disabled */
    }
  };
  const sections = choosing
    ? [section]
    : pins === null
      ? ['overview']
      : [...new Set(Object.values(pins).map((p) => p.section))];
  const sectionKey = sections.sort().join(',');
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    let current = true;
    const timeout = setTimeout(() => controller.abort(), 50_000);
    setReports({});
    setErrors([]);
    setLoading(true);
    const requested = sectionKey ? (sectionKey.split(',') as WebsiteStatsSection[]) : [];
    void Promise.all(
      requested.map(async (reportSection) => {
        try {
          const response = await fetch(
            apiUrl + '/v1/dashboard/website?section=' + reportSection + '&days=' + days,
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
            result.section !== reportSection
          )
            throw new Error('The website returned an unexpected report. Please retry.');
          if (current) setReports((old) => ({ ...old, [reportSection]: result }));
        } catch (err) {
          if (current)
            setErrors((old) => [
              ...old,
              (WEBSITE_STATS_SECTIONS.find((s) => s.id === reportSection)?.label ?? reportSection) +
                ': ' +
                (controller.signal.aborted
                  ? 'The website took too long to respond. Please retry.'
                  : err instanceof Error
                    ? err.message
                    : 'Website statistics are unavailable.'),
            ]);
        }
      }),
    ).finally(() => {
      clearTimeout(timeout);
      if (current) setLoading(false);
    });
    return () => {
      current = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [businessId, sectionKey, days, revision, ready]);
  // The initial dashboard shows Overview. The first edit makes that selection explicit.
  const effectivePins: Pins =
    pins ??
    Object.fromEntries(
      (reports.overview?.cards ?? []).map((card) => [
        pinKey('overview', card.id),
        { section: 'overview', id: card.id, metrics: null, tables: true },
      ]),
    );
  const choose = (reportSection: WebsiteStatsSection, card: StatsCard, enabled: boolean) => {
    const next = { ...effectivePins };
    const key = pinKey(reportSection, card.id);
    if (enabled) next[key] = { section: reportSection, id: card.id, metrics: null, tables: true };
    else delete next[key];
    save(next);
  };
  const cards = Object.values(reports).flatMap((report) =>
    report.cards.map((card) => ({ report, card })),
  );
  const displayed = choosing
    ? cards
    : cards.filter(({ report, card }) => effectivePins[pinKey(report.section, card.id)]);
  return (
    <section
      className={styles.website}
      aria-labelledby="website-stats-title"
      data-testid="website-statistics"
    >
      <div className={styles.header}>
        <div>
          <h2 id="website-stats-title">Website statistics</h2>
          <p>Online business · Sitewide · Independent of store filters</p>
        </div>
        <div className={styles.controls}>
          <label>
            Website period
            <select
              aria-label="Website period"
              value={days}
              onChange={(e) => save(pins, Number(e.target.value) as 7 | 30 | 90)}
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </label>
          <button
            className={'btn btn-sm ' + (choosing ? 'btn-primary' : 'btn-secondary')}
            type="button"
            aria-expanded={choosing}
            onClick={() => {
              if (!choosing && pins === null && reports.overview) save(effectivePins);
              setChoosing(!choosing);
            }}
          >
            {choosing ? 'Done choosing' : 'Choose stats'}
          </button>
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
            href="https://www.mattressstoreslosangeles.com/admin"
            target="_blank"
            rel="noopener noreferrer"
          >
            Website admin ↗
          </a>
        </div>
      </div>
      {choosing && (
        <>
          <p className={styles.note}>
            Choose cards and individual figures from any section. Your dashboard combines your
            selections. Saved for you in this browser.
          </p>
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
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            onClick={() => {
              save(null);
              setSection('overview');
            }}
          >
            Reset to Overview
          </button>
        </>
      )}
      <div aria-live="polite">
        {loading && (
          <div className={styles.loading} role="status">
            Loading website statistics…
          </div>
        )}
        {errors.length > 0 && (
          <div className={styles.error} role="alert">
            <span>{errors.join(' ')}</span>
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
      {!loading && !errors.length && displayed.length === 0 && (
        <p className={styles.note}>
          No website stats selected. Use Choose stats to add the figures you want.
        </p>
      )}
      <div className={styles.cards}>
        {displayed.map(({ report, card }) => {
          const key = pinKey(report.section, card.id);
          const pin = effectivePins[key];
          const visibleCard =
            choosing || !pin
              ? card
              : {
                  ...card,
                  metrics:
                    pin.metrics === null
                      ? card.metrics
                      : card.metrics.filter((m) => pin.metrics!.includes(m.label)),
                  tables: pin.tables ? card.tables : [],
                };
          return (
            <div key={key}>
              {choosing && (
                <fieldset className={styles.picker}>
                  <legend>
                    <label>
                      <input
                        type="checkbox"
                        checked={!!pin}
                        onChange={(e) => choose(report.section, card, e.target.checked)}
                      />{' '}
                      Show {card.title}
                    </label>
                  </legend>
                  {pin && (
                    <div className={styles.pickerMetrics}>
                      {card.metrics.map((m) => (
                        <label key={m.label}>
                          <input
                            type="checkbox"
                            checked={pin.metrics === null || pin.metrics.includes(m.label)}
                            onChange={(e) => {
                              const metrics = new Set(
                                pin.metrics ?? card.metrics.map((m) => m.label),
                              );
                              if (e.target.checked) metrics.add(m.label);
                              else metrics.delete(m.label);
                              save({ ...effectivePins, [key]: { ...pin, metrics: [...metrics] } });
                            }}
                          />{' '}
                          {m.label}
                        </label>
                      ))}
                      {card.tables.length > 0 && (
                        <label>
                          <input
                            type="checkbox"
                            checked={pin.tables}
                            onChange={(e) =>
                              save({
                                ...effectivePins,
                                [key]: { ...pin, tables: e.target.checked },
                              })
                            }
                          />{' '}
                          Detail tables & charts
                        </label>
                      )}
                    </div>
                  )}
                </fieldset>
              )}
              <WebsiteCard card={{ ...visibleCard, id: report.section + '-' + card.id }} />
              <p className={styles.updated}>
                {WEBSITE_STATS_SECTIONS.find((s) => s.id === report.section)?.label} · Updated{' '}
                {new Date(report.generatedAt).toLocaleTimeString('en-US', {
                  timeZone: 'America/Los_Angeles',
                  hour: 'numeric',
                  minute: '2-digit',
                })}{' '}
                PT
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
