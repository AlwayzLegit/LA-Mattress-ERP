import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { websiteStatsReportSchema, type WebsiteStatsReport } from '@jetnine/shared';
import { WebsiteStatsController, WebsiteStatsService } from './website-stats.controller';
import { REQUIRED_PERMISSIONS_KEY } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';

const businessId = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const owner: RequestTenantContext = {
  userId: 'owner',
  businessId,
  membershipId: 'member',
  roleId: 'role',
  roleName: 'Owner',
  isSuperAdmin: false,
  permissions: new Set(['reports.financial.view']),
  dataScope: 'all',
  sellingScope: 'all',
  scopeLocationIds: null,
  ip: null,
  userAgent: null,
  impersonatorUserId: null,
  apiKeyId: null,
  auditLogged: false,
};
const report: WebsiteStatsReport = {
  version: 1,
  businessId,
  section: 'overview',
  days: 30,
  generatedAt: '2026-09-14T20:00:00.000Z',
  timezone: 'America/Los_Angeles',
  cards: [
    {
      id: 'sales',
      title: 'Website sales',
      source: 'Shopify',
      status: 'ready',
      note: 'Website only',
      metrics: [
        { label: 'Revenue', value: 12345, format: 'money', currency: 'USD' },
        { label: 'Orders', value: 0, format: 'number' },
      ],
      tables: [],
    },
  ],
};
let service: WebsiteStatsService;
const upstream = vi.fn();
beforeEach(() => {
  service = new WebsiteStatsService();
  vi.stubEnv('WEBSITE_STATS_BUSINESS_ID', businessId);
  vi.stubEnv('WEBSITE_STATS_ORIGIN', 'https://website.example');
  vi.stubEnv('WEBSITE_STATS_TOKEN', 'test-read-only-token-'.repeat(3));
  upstream.mockReset().mockImplementation(async () => Response.json(report));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('owner website statistics boundary', () => {
  it('requires financial permission in addition to owner/tenant enforcement', () => {
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, WebsiteStatsController.prototype.read),
    ).toEqual(['reports.financial.view']);
    expect(() => new WebsiteStatsController(service).read(owner, 'revenue', '365')).toThrow();
    expect(() => new WebsiteStatsController(service).read(owner, '../../admin', '30')).toThrow();
  });
  it.each([
    { roleName: 'Manager' },
    { roleName: 'Cashier' },
    { userId: null, apiKeyId: 'machine' },
    { businessId: null },
    { dataScope: 'store' as const },
  ])('denies non-owner or restricted context before any fetch: %j', async (change) => {
    await expect(service.read({ ...owner, ...change }, 'overview', 30)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(upstream).not.toHaveBeenCalled();
  });
  it('does not leak a warm report to another tenant or another role', async () => {
    await service.read(owner, 'overview', 30);
    await expect(
      service.read({ ...owner, businessId: other }, 'overview', 30),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      service.read({ ...owner, roleName: 'Manager' }, 'overview', 30),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it('uses a dedicated server credential and validates the report binding', async () => {
    expect(await service.read(owner, 'overview', 30)).toEqual(report);
    const [url, init] = upstream.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://website.example/api/erp/website-stats?section=overview&days=30',
    );
    expect(init.headers['x-erp-business-id']).toBe(businessId);
    expect(init.headers.authorization).toBe('Bearer ' + process.env.WEBSITE_STATS_TOKEN);
    expect(init.redirect).toBe('error');
    expect(JSON.stringify(report)).not.toContain(process.env.WEBSITE_STATS_TOKEN);
  });
  it.each([
    { ...report, businessId: other },
    { ...report, section: 'calls' },
    { ...report, days: 7 },
    { ...report, version: 2 },
    {
      ...report,
      cards: [
        {
          ...report.cards[0],
          metrics: [{ label: 'Bad', format: 'script', value: 'javascript:bad' }],
        },
      ],
    },
  ])('rejects wrong-tenant, wrong-period, or invalid reports', async (payload) => {
    upstream.mockImplementation(async () => Response.json(payload));
    await expect(service.read(owner, 'overview', 30)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
  it('deduplicates concurrent reads and caches only successful responses for one minute', async () => {
    await Promise.all([service.read(owner, 'overview', 30), service.read(owner, 'overview', 30)]);
    await service.read(owner, 'overview', 30);
    expect(upstream).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    await service.read(owner, 'overview', 30);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
  it('does not cache a failure or expose provider diagnostics', async () => {
    upstream.mockImplementationOnce(
      async () => new Response('provider secret token', { status: 500 }),
    );
    await expect(service.read(owner, 'overview', 30)).rejects.toThrow(
      'Website statistics could not be loaded',
    );
    expect(await service.read(owner, 'overview', 30)).toEqual(report);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
  it('rejects oversized bodies, including chunked responses', async () => {
    upstream.mockImplementationOnce(async () => new Response('x'.repeat(1_000_001)));
    await expect(service.read(owner, 'overview', 30)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
  it.each([
    'http://website.example',
    'https://user:secret@website.example',
    'https://website.example/path',
    'https://website.example?redirect=evil',
  ])('rejects unsafe configured origin %s', async (origin) => {
    vi.stubEnv('WEBSITE_STATS_ORIGIN', origin);
    await expect(service.read(owner, 'overview', 30)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(upstream).not.toHaveBeenCalled();
  });
  it('keeps unavailable, zero, and unknown values distinct and strips extra provider fields', () => {
    const parsed = websiteStatsReportSchema.parse({
      ...report,
      credential: 'private',
      cards: [
        {
          ...report.cards[0],
          secret: 'private',
          metrics: [
            { label: 'Zero', value: 0, format: 'money' },
            { label: 'Unknown', value: null, format: 'number' },
          ],
        },
      ],
    });
    expect(parsed.cards[0]!.metrics.map((m) => m.value)).toEqual([0, null]);
    expect(JSON.stringify(parsed)).not.toContain('private');
  });
});
