import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant } from '../auth/current-user.decorator';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { ENTITY_SPECS } from './import-spec';
import { ImportService } from './import.service';

/**
 * STORIS import wizard endpoints (§7). Flow per entity, in the order
 * `GET /v1/import/entities` lists them: stage the CSV → adjust the
 * mapping if the auto-map missed columns → validate → commit → check
 * the recon gates. Everything is re-runnable (D7): re-committing a
 * batch, or a corrected re-upload of the same file, updates the same
 * records through `legacy_refs`.
 */
@TenantScoped()
@Controller('v1/import')
export class ImportController {
  constructor(
    @Inject(ImportService) private readonly importService: ImportService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Supported entities + field specs, in dependency order for the wizard. */
  @Get('entities')
  @RequirePermission('import.run')
  entities(@CurrentTenant() _tenant: RequestTenantContext) {
    return ENTITY_SPECS.map((s) => ({
      entity: s.entity,
      label: s.label,
      fields: s.fields.map((f) => ({ name: f.name, type: f.type, required: f.required ?? false })),
    }));
  }

  @Post('batches')
  @RequirePermission('import.run')
  async stage(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: { entity?: string; filename?: string; csv?: string },
  ) {
    if (!body.entity) throw new BadRequestException('entity is required');
    if (!body.csv) throw new BadRequestException('csv is required');
    const batch = await this.importService.stage(tenant.businessId!, tenant.userId ?? undefined, {
      entity: body.entity,
      filename: body.filename,
      csv: body.csv,
    });
    await this.audit.log({
      action: 'import.stage',
      targetType: 'import_batch',
      targetId: batch.id,
      metadata: { entity: body.entity, filename: body.filename ?? null, rows: batch.rowCount },
    });
    return batch;
  }

  @Get('batches')
  @RequirePermission('import.run')
  async list(@CurrentTenant() _tenant: RequestTenantContext, @Query('entity') entity?: string) {
    return this.importService.listBatches(entity);
  }

  @Get('batches/:id')
  @RequirePermission('import.run')
  async get(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
    @Query('rows') rows?: string,
  ) {
    const batch = await this.importService.getBatch(id);
    return {
      ...batch,
      rows:
        rows === 'none' ? undefined : await this.importService.batchRows(id, rows === 'invalid'),
    };
  }

  @Post('batches/:id/mapping')
  @RequirePermission('import.run')
  async setMapping(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: { columns?: Record<string, string> },
  ) {
    if (!body.columns) throw new BadRequestException('columns is required');
    return this.importService.setMapping(id, body.columns);
  }

  @Post('batches/:id/validate')
  @RequirePermission('import.run')
  async validate(@CurrentTenant() tenant: RequestTenantContext, @Param('id') id: string) {
    return this.importService.validate(tenant.businessId!, id);
  }

  @Post('batches/:id/commit')
  @RequirePermission('import.run')
  async commit(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body?: { replaceCatalog?: boolean },
  ) {
    const result = await this.importService.commit(tenant.businessId!, id, {
      replaceCatalog: body?.replaceCatalog === true,
    });
    await this.audit.log({
      action: 'import.commit',
      targetType: 'import_batch',
      targetId: id,
      metadata: {
        entity: result.batch!.entity,
        committed: result.committed,
        failed: result.failed,
        ...(result.replaced ? { replaced: result.replaced } : {}),
        ...(result.replaceSkipped ? { replaceSkipped: result.replaceSkipped } : {}),
      },
    });
    return result;
  }

  /** Recon gates 1–4 (§7); run after each rehearsal and the final delta. */
  @Get('recon')
  @RequirePermission('import.run')
  async recon(@CurrentTenant() tenant: RequestTenantContext) {
    return this.importService.recon(tenant.businessId!);
  }
}
