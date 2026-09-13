import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { buildCategoryIndex } from '../catalog/category-tree';
import { DRIZZLE } from '../database/database.module';

export interface TemplateSnapshot {
  settings?: {
    currencyCode: string;
    defaultTaxRateBps: number;
    receiptHeader: string | null;
    receiptFooter: string | null;
  };
  roles?: { name: string; description: string | null; permissions: string[] }[];
  categories?: { name: string; parentName: string | null; position: number }[];
  taxClasses?: {
    name: string;
    description: string | null;
    rateBps: number;
    isDefault: boolean;
  }[];
  products?: {
    sku: string | null;
    name: string;
    description: string | null;
    categoryName: string | null;
    serialTracked: boolean;
    variants: {
      sku: string | null;
      name: string | null;
      priceCents: number;
      costCents: number | null;
      barcode: string | null;
    }[];
  }[];
}

/**
 * The apply half of business templates, shared between the template
 * endpoints and business creation (create-from-template).
 */
@Injectable()
export class TemplatesService {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase) {}

  /**
   * Additive apply, shared with business creation. Existing rows (by
   * role name / category name / class name / product SKU) are skipped.
   */
  async applyTemplate(businessId: string, snapshot: TemplateSnapshot) {
    const result = { settings: false, roles: 0, categories: 0, taxClasses: 0, products: 0 };

    if (snapshot.settings) {
      await this.db
        .update(schema.businesses)
        .set({
          currencyCode: snapshot.settings.currencyCode,
          defaultTaxRateBps: snapshot.settings.defaultTaxRateBps,
          receiptHeader: snapshot.settings.receiptHeader,
          receiptFooter: snapshot.settings.receiptFooter,
          updatedAt: new Date(),
        })
        .where(eq(schema.businesses.id, businessId));
      result.settings = true;
    }

    if (snapshot.roles?.length) {
      const existing = new Set(
        (
          await this.db
            .select({ name: schema.roles.name })
            .from(schema.roles)
            .where(eq(schema.roles.businessId, businessId))
        ).map((r) => r.name),
      );
      for (const role of snapshot.roles) {
        if (existing.has(role.name)) continue;
        const [r] = await this.db
          .insert(schema.roles)
          .values({
            businessId,
            name: role.name,
            description: role.description,
            isSystem: false,
          })
          .returning({ id: schema.roles.id });
        if (role.permissions.length > 0) {
          await this.db
            .insert(schema.rolePermissions)
            .values(role.permissions.map((permission) => ({ roleId: r!.id, permission })));
        }
        result.roles += 1;
      }
    }

    if (snapshot.categories?.length) {
      const existing = new Map(
        (
          await this.db
            .select({ id: schema.categories.id, name: schema.categories.name })
            .from(schema.categories)
            .where(eq(schema.categories.businessId, businessId))
        ).map((c) => [c.name, c.id]),
      );
      // Parents first so children can reference them.
      const pending = [...snapshot.categories].sort(
        (a, b) => Number(a.parentName !== null) - Number(b.parentName !== null),
      );
      for (const cat of pending) {
        if (existing.has(cat.name)) continue;
        const [c] = await this.db
          .insert(schema.categories)
          .values({
            businessId,
            name: cat.name,
            position: cat.position,
            parentId: cat.parentName ? (existing.get(cat.parentName) ?? null) : null,
          })
          .returning({ id: schema.categories.id });
        existing.set(cat.name, c!.id);
        result.categories += 1;
      }
    }

    if (snapshot.taxClasses?.length) {
      const existing = new Set(
        (
          await this.db
            .select({ name: schema.taxClasses.name })
            .from(schema.taxClasses)
            .where(eq(schema.taxClasses.businessId, businessId))
        ).map((t) => t.name),
      );
      for (const t of snapshot.taxClasses) {
        if (existing.has(t.name)) continue;
        await this.db.insert(schema.taxClasses).values({
          businessId,
          name: t.name,
          description: t.description,
          rateBps: t.rateBps,
          isDefault: t.isDefault,
        });
        result.taxClasses += 1;
      }
    }

    if (snapshot.products?.length) {
      // Snapshots record the category path ("Mattresses › Hybrid"); older
      // ones the bare name. Resolve the path first, then the leaf name.
      const cats = await this.db
        .select({
          id: schema.categories.id,
          parentId: schema.categories.parentId,
          name: schema.categories.name,
        })
        .from(schema.categories)
        .where(eq(schema.categories.businessId, businessId));
      const categoryIndex = buildCategoryIndex(cats);
      const catIds = new Map<string, string>();
      for (const c of cats) if (!catIds.has(c.name)) catIds.set(c.name, c.id);
      for (const c of cats) catIds.set(categoryIndex.pathOf(c.id)!, c.id);
      const existingSkus = new Set(
        (
          await this.db
            .select({ sku: schema.products.sku })
            .from(schema.products)
            .where(eq(schema.products.businessId, businessId))
        ).map((p) => p.sku),
      );
      for (const p of snapshot.products) {
        if (p.sku && existingSkus.has(p.sku)) continue;
        const [created] = await this.db
          .insert(schema.products)
          .values({
            businessId,
            sku: p.sku,
            name: p.name,
            description: p.description,
            categoryId: p.categoryName ? (catIds.get(p.categoryName) ?? null) : null,
            serialTracked: p.serialTracked,
          })
          .returning({ id: schema.products.id });
        if (p.variants.length > 0) {
          await this.db.insert(schema.productVariants).values(
            p.variants.map((v) => ({
              businessId,
              productId: created!.id,
              sku: v.sku,
              name: v.name,
              priceCents: v.priceCents,
              costCents: v.costCents,
              barcode: v.barcode,
            })),
          );
        }
        result.products += 1;
      }
    }

    return result;
  }
}
