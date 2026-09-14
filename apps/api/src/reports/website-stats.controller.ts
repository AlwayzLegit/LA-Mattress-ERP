import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Injectable,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  websiteStatsReportSchema,
  WEBSITE_STATS_SECTIONS,
  type WebsiteStatsReport,
  type WebsiteStatsSection,
} from '@jetnine/shared';
import { CurrentTenant } from '../auth/current-user.decorator';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';

const MAX_BYTES = 1_000_000;
interface Entry {
  report: WebsiteStatsReport;
  expires: number;
}
@Injectable()
export class WebsiteStatsService {
  private cache = new Map<string, Entry>();
  private pending = new Map<string, Promise<WebsiteStatsReport>>();
  async read(
    tenant: RequestTenantContext,
    section: WebsiteStatsSection,
    days: 7 | 30 | 90,
  ): Promise<WebsiteStatsReport> {
    // Check before cache access. Broad report permissions alone do not grant website-owner access.
    if (
      !tenant.userId ||
      tenant.apiKeyId ||
      !tenant.businessId ||
      tenant.dataScope !== 'all' ||
      (!tenant.isSuperAdmin && tenant.roleName !== 'Owner')
    )
      throw new ForbiddenException('Website statistics are available to the owner.');
    const businessId = process.env.WEBSITE_STATS_BUSINESS_ID?.trim();
    const origin = process.env.WEBSITE_STATS_ORIGIN?.trim();
    const token = process.env.WEBSITE_STATS_TOKEN?.trim();
    if (!businessId || businessId !== tenant.businessId || !origin || !token || token.length < 32) {
      throw new ServiceUnavailableException(
        'Website statistics are not connected for this business.',
      );
    }
    let url: URL;
    try {
      url = new URL(origin);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        throw new Error('origin');
    } catch {
      throw new ServiceUnavailableException('The website statistics connection needs attention.');
    }
    url.pathname = '/api/erp/website-stats';
    url.searchParams.set('section', section);
    url.searchParams.set('days', String(days));
    const key = `${businessId}|${origin}|${section}|${days}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.report;
    const active = this.pending.get(key);
    if (active) return active;
    const task = this.fetchReport(url, token, businessId, section, days);
    this.pending.set(key, task);
    try {
      const report = await task;
      // Bounded cache: eleven sections x three periods for one configured business.
      if (this.cache.size >= 33) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { report, expires: Date.now() + 60_000 });
      return report;
    } finally {
      this.pending.delete(key);
    }
  }
  private async fetchReport(
    url: URL,
    token: string,
    businessId: string,
    section: WebsiteStatsSection,
    days: 7 | 30 | 90,
  ): Promise<WebsiteStatsReport> {
    try {
      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          'x-erp-business-id': businessId,
          accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(45_000),
      });
      if (
        !response.ok ||
        Number(response.headers.get('content-length') ?? 0) > MAX_BYTES ||
        !response.body
      )
        throw new Error('upstream');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) throw new Error('size');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const report = websiteStatsReportSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      if (report.businessId !== businessId || report.section !== section || report.days !== days)
        throw new Error('binding');
      return report;
    } catch {
      // Provider response bodies, URLs and credentials never reach the browser or logs.
      throw new ServiceUnavailableException(
        'Website statistics could not be loaded. Try again shortly.',
      );
    }
  }
}
@TenantScoped()
@Controller('v1/dashboard/website')
export class WebsiteStatsController {
  constructor(@Inject(WebsiteStatsService) private readonly stats: WebsiteStatsService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @RequirePermission('reports.financial.view')
  read(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('section') section = 'overview',
    @Query('days') days = '30',
  ) {
    if (!WEBSITE_STATS_SECTIONS.some((s) => s.id === section) || !['7', '30', '90'].includes(days))
      throw new BadRequestException('Choose a website section and 7, 30 or 90 days.');
    return this.stats.read(tenant, section as WebsiteStatsSection, Number(days) as 7 | 30 | 90);
  }
}
