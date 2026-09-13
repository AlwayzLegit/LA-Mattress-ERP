import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { loadCategoryIndex } from '../catalog/category-tree';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, type CurrentUserPayload } from '../auth/current-user.decorator';
import { DRIZZLE } from '../database/database.module';
import { SuperAdminOnly, TenantScoped } from '../tenancy/decorators';
import { TemplatesService, type TemplateSnapshot } from './templates.service';

export interface TemplateScope {
  settings: boolean;
  roles: boolean;
  categories: boolean;
  taxClasses: boolean;
  products: boolean;
}

const DEFAULT_SCOPE: TemplateScope = {
  settings: true,
  roles: true,
  categories: true,
  taxClasses: true,
  products: false,
};

/**
 * Business templates (platform layer, P1): snapshot one business's
 * configuration and stamp it onto another. Snapshot captures custom
 * (non-system) roles, category tree, tax classes, settings, and —
 * opt-in — the whole catalog. Apply is additive and name/SKU-keyed:
 * whatever already exists on the target is left alone, so applying
 * twice is safe.
 */
@SuperAdminOnly()
@TenantScoped()
@Controller('v1/admin/templates')
export class AdminTemplatesController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TemplatesService) private readonly templates: TemplatesService,
  ) {}

  @Get()
  async list() {
    return this.db
      .select({
        id: schema.businessTemplates.id,
        name: schema.businessTemplates.name,
        description: schema.businessTemplates.description,
        sourceBusinessId: schema.businessTemplates.sourceBusinessId,
        scopeJson: schema.businessTemplates.scopeJson,
        createdAt: schema.businessTemplates.createdAt,
      })
      .from(schema.businessTemplates)
      .orderBy(desc(schema.businessTemplates.createdAt))
      .limit(100);
  }

  @Post('snapshot')
  async snapshot(
    @CurrentUser() actor: CurrentUserPayload,
    @Body()
    body: {
      businessId?: string;
      name?: string;
      description?: string;
      scope?: Partial<TemplateScope>;
    },
  ) {
    if (!body.businessId) throw new BadRequestException('businessId is required');
    if (!body.name?.trim()) throw new BadRequestException('name is required');
    const [biz] = await this.db
      .select()
      .from(schema.businesses)
      .where(eq(schema.businesses.id, body.businessId))
      .limit(1);
    if (!biz) throw new NotFoundException('Business not found');
    const scope: TemplateScope = { ...DEFAULT_SCOPE, ...(body.scope ?? {}) };

    const snapshot: TemplateSnapshot = {};
    if (scope.settings) {
      snapshot.settings = {
        currencyCode: biz.currencyCode,
        defaultTaxRateBps: biz.defaultTaxRateBps,
        receiptHeader: biz.receiptHeader,
        receiptFooter: biz.receiptFooter,
      };
    }
    if (scope.roles) {
      const roles = await this.db
        .select()
        .from(schema.roles)
        .where(and(eq(schema.roles.businessId, biz.id), eq(schema.roles.isSystem, false)));
      const perms =
        roles.length > 0
          ? await this.db
              .select()
              .from(schema.rolePermissions)
              .where(
                inArray(
                  schema.rolePermissions.roleId,
                  roles.map((r) => r.id),
                ),
              )
          : [];
      snapshot.roles = roles.map((r) => ({
        name: r.name,
        description: r.description,
        permissions: perms.filter((p) => p.roleId === r.id).map((p) => p.permission),
      }));
    }
    if (scope.categories) {
      const cats = await this.db
        .select()
        .from(schema.categories)
        .where(eq(schema.categories.businessId, biz.id));
      const nameById = new Map(cats.map((c) => [c.id, c.name]));
      snapshot.categories = cats.map((c) => ({
        name: c.name,
        parentName: c.parentId ? (nameById.get(c.parentId) ?? null) : null,
        position: c.position,
      }));
    }
    if (scope.taxClasses) {
      const classes = await this.db
        .select()
        .from(schema.taxClasses)
        .where(eq(schema.taxClasses.businessId, biz.id));
      snapshot.taxClasses = classes.map((t) => ({
        name: t.name,
        description: t.description,
        rateBps: t.rateBps,
        isDefault: t.isDefault,
      }));
    }
    if (scope.products) {
      const products = await this.db
        .select()
        .from(schema.products)
        .where(eq(schema.products.businessId, biz.id));
      // A22.1: categories nest, so a product records its full path and
      // apply resolves it path-first (name as the legacy fallback).
      const categoryIndex = await loadCategoryIndex(this.db, biz.id);
      const variants =
        products.length > 0
          ? await this.db
              .select()
              .from(schema.productVariants)
              .where(eq(schema.productVariants.businessId, biz.id))
          : [];
      snapshot.products = products.map((p) => ({
        sku: p.sku,
        name: p.name,
        description: p.description,
        categoryName: categoryIndex.pathOf(p.categoryId),
        serialTracked: p.serialTracked,
        variants: variants
          .filter((v) => v.productId === p.id)
          .map((v) => ({
            sku: v.sku,
            name: v.name,
            priceCents: v.priceCents,
            costCents: v.costCents,
            barcode: v.barcode,
          })),
      }));
    }

    const [tpl] = await this.db
      .insert(schema.businessTemplates)
      .values({
        name: body.name.trim(),
        description: body.description?.trim() ?? null,
        sourceBusinessId: biz.id,
        snapshotJson: snapshot,
        scopeJson: scope,
        createdByUserId: actor.id,
      })
      .returning();
    await this.audit.log({
      action: 'platform.template.snapshot',
      targetType: 'business_template',
      targetId: tpl!.id,
      metadata: { name: tpl!.name, sourceBusinessId: biz.id, scope },
    });
    return tpl;
  }

  @Post(':id/apply')
  async apply(@Param('id') id: string, @Body() body: { businessId?: string }) {
    if (!body.businessId) throw new BadRequestException('businessId is required');
    const [tpl] = await this.db
      .select()
      .from(schema.businessTemplates)
      .where(eq(schema.businessTemplates.id, id))
      .limit(1);
    if (!tpl) throw new NotFoundException('Template not found');
    const [biz] = await this.db
      .select()
      .from(schema.businesses)
      .where(eq(schema.businesses.id, body.businessId))
      .limit(1);
    if (!biz) throw new NotFoundException('Business not found');

    const result = await this.templates.applyTemplate(biz.id, tpl.snapshotJson as TemplateSnapshot);
    await this.audit.log({
      action: 'platform.template.apply',
      targetType: 'business_template',
      targetId: tpl.id,
      metadata: { businessId: biz.id, ...result },
    });
    return result;
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const [tpl] = await this.db
      .delete(schema.businessTemplates)
      .where(eq(schema.businessTemplates.id, id))
      .returning({ id: schema.businessTemplates.id, name: schema.businessTemplates.name });
    if (!tpl) throw new NotFoundException('Template not found');
    await this.audit.log({
      action: 'platform.template.delete',
      targetType: 'business_template',
      targetId: tpl.id,
      metadata: { name: tpl.name },
    });
    return { ok: true };
  }
}
