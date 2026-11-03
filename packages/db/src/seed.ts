import { DEFAULT_AS_IS_REASON_CODES, SYSTEM_ROLES } from '@jetnine/shared';
import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { createClient } from './client';
import {
  accounts,
  businesses,
  categories,
  inventoryLevels,
  inventoryMovements,
  locations,
  memberships,
  productVariants,
  products,
  reasonCodes,
  rolePermissions,
  roles,
  users,
} from './schema';

const SEED_PASSWORD = 'ChangeMe!2024';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required to run the seed.');
    process.exit(1);
  }

  const { db, sql } = createClient({ url, max: 1 });

  try {
    const passwordHash = await hashPassword(SEED_PASSWORD);

    // 1. Super-admin user + matching credential. The hash uses better-auth's
    //    scrypt parameters so the seeded user can sign in immediately.
    const [superAdmin] = await db
      .insert(users)
      .values({
        email: 'admin@jetnine.local',
        emailVerified: true,
        name: 'Platform Super Admin',
        isSuperAdmin: true,
      })
      .returning();
    if (!superAdmin) throw new Error('failed to insert super admin user');
    await db.insert(accounts).values({
      accountId: superAdmin.id,
      providerId: 'credential',
      userId: superAdmin.id,
      password: passwordHash,
    });

    // 2. Demo business
    const [demo] = await db
      .insert(businesses)
      .values({
        slug: 'acme-furniture',
        name: 'Acme Furniture',
        status: 'active',
        plan: 'starter',
      })
      .returning();
    if (!demo) throw new Error('failed to insert demo business');

    // 3. System roles (cloned from packages/shared catalog) + role permissions
    const seededRoles: { id: string; name: string }[] = [];
    for (const role of SYSTEM_ROLES) {
      const [inserted] = await db
        .insert(roles)
        .values({
          businessId: demo.id,
          name: role.name,
          description: role.description,
          isSystem: true,
        })
        .returning();
      if (!inserted) throw new Error(`failed to insert role ${role.name}`);
      seededRoles.push({ id: inserted.id, name: inserted.name });

      if (role.permissions.length > 0) {
        await db.insert(rolePermissions).values(
          role.permissions.map((permission) => ({
            roleId: inserted.id,
            permission,
          })),
        );
      }
    }

    const ownerRole = seededRoles.find((r) => r.name === 'Owner');
    if (!ownerRole) throw new Error('Owner role missing after seed');

    // 3b. The standard As-Is reasons (owner 2026-11-02) — the same list
    // business creation seeds in the API.
    await db.insert(reasonCodes).values(
      DEFAULT_AS_IS_REASON_CODES.map((c) => ({
        businessId: demo.id,
        code: c.code,
        description: c.description,
        usageClass: 'as_is',
      })),
    );

    // 4. Demo owner user + credential + membership
    const [demoOwner] = await db
      .insert(users)
      .values({
        email: 'owner@acme.local',
        emailVerified: true,
        name: 'Acme Owner',
      })
      .returning();
    if (!demoOwner) throw new Error('failed to insert demo owner');
    await db.insert(accounts).values({
      accountId: demoOwner.id,
      providerId: 'credential',
      userId: demoOwner.id,
      password: passwordHash,
    });

    await db.insert(memberships).values({
      businessId: demo.id,
      userId: demoOwner.id,
      roleId: ownerRole.id,
      status: 'active',
      acceptedAt: new Date(),
    });

    // 5. One location
    const [mainStore] = await db
      .insert(locations)
      .values({
        businessId: demo.id,
        name: 'Main Store',
        timezone: 'America/Los_Angeles',
        addressJson: { line1: '100 Main St', city: 'Springfield', state: 'IL', postal: '62701' },
      })
      .returning();
    if (!mainStore) throw new Error('failed to insert location');

    // 6. Sample category + products
    const [furniture] = await db
      .insert(categories)
      .values({ businessId: demo.id, name: 'Furniture', position: 0 })
      .returning();
    if (!furniture) throw new Error('failed to insert category');

    const sampleProducts = [
      {
        sku: 'SOFA-001',
        name: 'Linen Sofa',
        variants: [
          { sku: 'SOFA-001-BG', name: 'Beige', priceCents: 129900, costCents: 65000 },
          { sku: 'SOFA-001-GY', name: 'Grey', priceCents: 129900, costCents: 65000 },
        ],
      },
      {
        sku: 'CHAIR-001',
        name: 'Oak Dining Chair',
        variants: [{ sku: 'CHAIR-001', name: 'Default', priceCents: 24900, costCents: 12000 }],
      },
      {
        sku: 'LAMP-001',
        name: 'Brass Floor Lamp',
        variants: [{ sku: 'LAMP-001', name: 'Default', priceCents: 18900, costCents: 8500 }],
      },
    ];

    for (const p of sampleProducts) {
      const [product] = await db
        .insert(products)
        .values({
          businessId: demo.id,
          sku: p.sku,
          name: p.name,
          categoryId: furniture.id,
        })
        .returning();
      if (!product) throw new Error(`failed to insert product ${p.sku}`);

      for (const v of p.variants) {
        const [variant] = await db
          .insert(productVariants)
          .values({
            businessId: demo.id,
            productId: product.id,
            sku: v.sku,
            name: v.name,
            priceCents: v.priceCents,
            costCents: v.costCents,
          })
          .returning();
        if (!variant) throw new Error(`failed to insert variant ${v.sku}`);

        await db.insert(inventoryLevels).values({
          businessId: demo.id,
          variantId: variant.id,
          locationId: mainStore.id,
          onHand: 10,
        });
        await db.insert(inventoryMovements).values({
          businessId: demo.id,
          variantId: variant.id,
          locationId: mainStore.id,
          delta: 10,
          reason: 'receive',
          actorUserId: demoOwner.id,
          notes: 'Initial seed stock',
        });
      }
    }

    const totalProducts = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.businessId, demo.id));

    console.error(
      `Seed complete: super-admin=${superAdmin.email}, business=${demo.slug}, owner=${demoOwner.email}, products=${totalProducts.length}, password=${SEED_PASSWORD}.`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
