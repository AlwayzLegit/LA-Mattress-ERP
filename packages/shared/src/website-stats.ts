/** Versioned read-only presentation contract shared with the ERP. No provider credentials or raw contact/session records. All money values are integer cents. */
export type StatsFormat =
  | 'text'
  | 'date'
  | 'datetime'
  | 'number'
  | 'money'
  | 'percent'
  | 'ratio'
  | 'seconds'
  | 'milliseconds';
export type StatsValue = string | number | null;
export interface StatsMetric {
  label: string;
  value: StatsValue;
  format: StatsFormat;
  previous?: StatsValue;
  currency?: string;
}
export interface StatsColumn {
  key: string;
  label: string;
  format: StatsFormat;
}
export interface StatsTable {
  title: string;
  columns: StatsColumn[];
  rows: Record<string, StatsValue>[];
}
export interface StatsCard {
  id: string;
  title: string;
  source: string;
  status: 'ready' | 'unavailable' | 'unconfigured';
  note: string;
  metrics: StatsMetric[];
  tables: StatsTable[];
}
export const WEBSITE_STATS_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'revenue', label: 'Revenue' },
  { id: 'customers', label: 'Customers' },
  { id: 'funnel', label: 'Conversion' },
  { id: 'chat', label: 'Chat' },
  { id: 'acquisition', label: 'Traffic' },
  { id: 'attribution', label: 'Attribution' },
  { id: 'store-actions', label: 'Store actions' },
  { id: 'calls', label: 'Calls' },
  { id: 'catalog', label: 'Catalog & search' },
  { id: 'system', label: 'Site health' },
] as const;
export type WebsiteStatsSection = (typeof WEBSITE_STATS_SECTIONS)[number]['id'];
export interface WebsiteStatsReport {
  version: 1;
  businessId: string;
  section: WebsiteStatsSection;
  days: 7 | 30 | 90;
  generatedAt: string;
  timezone: 'America/Los_Angeles';
  cards: StatsCard[];
}

import { z } from 'zod';
const value = z.union([z.string().max(1000), z.number().finite(), z.null()]);
const format = z.enum([
  'text',
  'date',
  'datetime',
  'number',
  'money',
  'percent',
  'ratio',
  'seconds',
  'milliseconds',
]);
const column = z.object({ key: z.string().max(80), label: z.string().max(100), format });
const metric = z.object({
  label: z.string().max(100),
  value,
  format,
  previous: value.optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});
const table = z.object({
  title: z.string().max(150),
  columns: z.array(column).max(15),
  rows: z.array(z.record(z.string().max(80), value)).max(250),
});
export const websiteStatsReportSchema = z.object({
  version: z.literal(1),
  businessId: z.string().uuid(),
  section: z.enum([
    'overview',
    'revenue',
    'customers',
    'funnel',
    'chat',
    'acquisition',
    'attribution',
    'store-actions',
    'calls',
    'catalog',
    'system',
  ]),
  days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  generatedAt: z.string().datetime(),
  timezone: z.literal('America/Los_Angeles'),
  cards: z
    .array(
      z.object({
        id: z.string().max(80),
        title: z.string().max(150),
        source: z.string().max(80),
        status: z.enum(['ready', 'unavailable', 'unconfigured']),
        note: z.string().max(1500),
        metrics: z.array(metric).max(30),
        tables: z.array(table).max(10),
      }),
    )
    .max(50),
});
