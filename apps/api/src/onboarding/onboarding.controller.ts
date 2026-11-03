import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Res,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import { and, count, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { isSupportedCurrency, SUPPORTED_CURRENCIES, SYSTEM_ROLES } from '@jetnine/shared';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../auth/current-user.decorator';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import { seedDefaultReasonCodes } from '../controls/default-reason-codes';
import { DRIZZLE } from '../database/database.module';

interface CreateOnboardingBody {
  name?: string;
  slug?: string;
  currencyCode?: string;
  /** Default tax rate in basis points (875 = 8.75%). Optional. */
  defaultTaxRateBps?: number;
}

interface OnboardingChecklist {
  /** ID of the business this checklist describes (the user's only one, or their currently-active one). */
  businessId: string;
  steps: {
    /** Stable key the UI keys off — don't change once shipped. */
    key:
      | 'business.created'
      | 'location.added'
      | 'product.added'
      | 'team.invited'
      | 'stripe.connected';
    /** Short, action-oriented label. */
    label: string;
    /** True when the step has been satisfied; the UI checks the box. */
    done: boolean;
    /** Where the user should go to complete it. */
    href: string;
  }[];
  /** True when every step is `done`. The UI hides the checklist after this. */
  complete: boolean;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_BUSINESSES_PER_USER = 5;

/**
 * Self-service onboarding for a freshly-signed-up user. Lets them
 * create their own business (becoming its Owner) without going
 * through a super-admin and seeds the Phase 1.5 system roles in
 * one round-trip.
 *
 * The companion `GET /v1/onboarding/checklist` reports what's left
 * to do for the user's active business so the dashboard can render
 * a "Next steps" panel that ticks off as the merchant configures
 * the rest of the platform.
 */
@Controller('v1/onboarding')
export class OnboardingController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Create a business as a normal authenticated user. The caller
   * becomes the Owner via a `memberships` row pointing at the seeded
   * Owner role. Capped at `MAX_BUSINESSES_PER_USER` self-service
   * creations to keep abuse manageable; super admins use the full
   * `/v1/admin/businesses` endpoint instead.
   */
  @Post('business')
  async createOwnBusiness(
    @CurrentUser() actor: CurrentUserPayload,
    @Body() body: CreateOnboardingBody,
  ): Promise<{ businessId: string }> {
    const name = body.name?.trim();
    const slug = body.slug?.trim().toLowerCase();
    if (!name) throw new BadRequestException('name is required');
    if (!slug || !SLUG_RE.test(slug) || slug.length > 64) {
      throw new BadRequestException(
        'slug must be 1-64 chars, lowercase alphanumeric, may contain inner hyphens',
      );
    }
    const currencyCode = (body.currencyCode ?? 'USD').toUpperCase();
    if (!isSupportedCurrency(currencyCode)) {
      throw new BadRequestException(
        `currencyCode must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`,
      );
    }
    const taxBps = body.defaultTaxRateBps ?? 0;
    if (!Number.isInteger(taxBps) || taxBps < 0 || taxBps > 100_000) {
      throw new BadRequestException('defaultTaxRateBps must be a non-negative integer ≤ 100000');
    }

    // Cap how many businesses a single user can mint via the self-
    // service path. Super-admin creations don't count — they go
    // through /v1/admin/businesses which lives behind a different
    // gate. Without a cap a single tester can spam unlimited rows
    // (each seeds 5 roles + 26 permissions).
    const ownedCount = await this.db
      .select({ n: count() })
      .from(schema.memberships)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
      .where(and(eq(schema.memberships.userId, actor.id), eq(schema.roles.name, 'Owner')));
    if ((ownedCount[0]?.n ?? 0) >= MAX_BUSINESSES_PER_USER) {
      throw new ForbiddenException(
        `Self-service business creation is capped at ${MAX_BUSINESSES_PER_USER}; contact support for more.`,
      );
    }

    // 1. Insert the business. New self-service businesses start in
    // 'trial' status with a 14-day window, mirroring the
    // super-admin path.
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    let biz;
    try {
      [biz] = await this.db
        .insert(schema.businesses)
        .values({
          slug,
          name,
          status: 'trial',
          plan: null,
          trialEndsAt,
          currencyCode,
          defaultTaxRateBps: taxBps,
        })
        .returning();
    } catch (err) {
      // Drizzle wraps the driver error, so the constraint name lives on the
      // `cause`, not the top-level message — checking only the latter let
      // every duplicate slug surface as a 500 instead of a 409.
      if (isUniqueViolation(err, 'businesses_slug_uniq')) {
        throw new ConflictException(`A business with slug "${slug}" already exists`);
      }
      throw err;
    }
    if (!biz) throw new UnprocessableEntityException('failed to create business');

    // 2. Subscription row so SubscriptionGuard can read trial state
    // immediately on the next request.
    await this.db.insert(schema.subscriptions).values({
      businessId: biz.id,
      plan: 'starter',
      status: 'trial',
      trialEndsAt,
    });

    // 3. Seed system roles + permissions. Same loop as the
    // super-admin create flow, kept verbatim so the two paths
    // produce identical role catalogs.
    const roleIdByName = new Map<string, string>();
    for (const role of SYSTEM_ROLES) {
      const [r] = await this.db
        .insert(schema.roles)
        .values({
          businessId: biz.id,
          name: role.name,
          description: role.description,
          isSystem: true,
        })
        .returning();
      if (!r) throw new UnprocessableEntityException(`failed to insert role ${role.name}`);
      roleIdByName.set(role.name, r.id);
      if (role.permissions.length > 0) {
        await this.db
          .insert(schema.rolePermissions)
          .values(role.permissions.map((permission) => ({ roleId: r.id, permission })));
      }
    }
    const ownerRoleId = roleIdByName.get('Owner');
    if (!ownerRoleId) throw new UnprocessableEntityException('Owner role missing after seed');
    // Owner 2026-11-02: the standard As-Is reasons, so the first Move to
    // As-Is is not a one-option picker.
    await seedDefaultReasonCodes(this.db, biz.id);

    // 4. The caller becomes the Owner. No invite / acceptance round
    // trip — they're already authenticated and verified.
    await this.db.insert(schema.memberships).values({
      businessId: biz.id,
      userId: actor.id,
      roleId: ownerRoleId,
      status: 'active',
      acceptedAt: new Date(),
    });

    // This route runs outside the tenant pipeline (the business does not
    // exist until the lines above), so the audit row's identity has to be
    // passed rather than read from the request context.
    await this.audit.log({
      action: 'business.create.self_service',
      targetType: 'business',
      targetId: biz.id,
      businessId: biz.id,
      actorUserId: actor.id,
      after: { slug, name, currencyCode, defaultTaxRateBps: taxBps },
    });

    return { businessId: biz.id };
  }

  /**
   * Onboarding progress for the user's most-recently-created
   * business. We resolve the active business by picking the one
   * the user has Owner / Manager membership in (ordered by
   * createdAt desc, take 1). Five steps cover the meaningful
   * configuration surface; once they're all green the UI hides
   * the panel.
   */
  @Get('checklist')
  async checklist(
    @CurrentUser() actor: CurrentUserPayload,
    // Fully manual response (NOT passthrough) so we can emit a literal
    // JSON `null` for the "no business yet" case. Returning `null` from a
    // Nest-managed handler ends the response with an empty body, so a
    // client doing `await res.json()` throws a parse error instead of
    // reading the documented `OnboardingChecklist | null`. The previous
    // passthrough + res.json() combination double-sent the response: on a
    // conditional request (If-None-Match) express's ETag handling had
    // already committed a 304 by the time Nest serialized the return
    // value, which threw "Cannot remove headers after they are sent" and
    // turned every dashboard revalidation into a 500.
    @Res() res: Response,
  ): Promise<void> {
    const memberships = await this.db
      .select({
        businessId: schema.memberships.businessId,
        createdAt: schema.businesses.createdAt,
      })
      .from(schema.memberships)
      .innerJoin(schema.businesses, eq(schema.businesses.id, schema.memberships.businessId))
      .where(and(eq(schema.memberships.userId, actor.id), eq(schema.memberships.status, 'active')));
    if (memberships.length === 0) {
      res.json(null);
      return;
    }
    // Most recently-created business is the one we onboard against.
    memberships.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const businessId = memberships[0]!.businessId;

    const [locationCount, productCount, memberCount, stripeAcct] = await Promise.all([
      this.db
        .select({ n: count() })
        .from(schema.locations)
        .where(eq(schema.locations.businessId, businessId)),
      this.db
        .select({ n: count() })
        .from(schema.products)
        .where(eq(schema.products.businessId, businessId)),
      this.db
        .select({ n: count() })
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.businessId, businessId),
            eq(schema.memberships.status, 'active'),
          ),
        ),
      this.db
        .select({ id: schema.merchantStripeAccounts.id })
        .from(schema.merchantStripeAccounts)
        .where(eq(schema.merchantStripeAccounts.businessId, businessId))
        .limit(1),
    ]);

    const steps: OnboardingChecklist['steps'] = [
      {
        key: 'business.created',
        label: 'Create your business',
        done: true,
        href: '/settings',
      },
      {
        key: 'location.added',
        label: 'Add your first location',
        done: (locationCount[0]?.n ?? 0) > 0,
        href: '/locations',
      },
      {
        key: 'product.added',
        label: 'Add a product',
        done: (productCount[0]?.n ?? 0) > 0,
        href: '/products/new',
      },
      {
        key: 'team.invited',
        label: 'Invite a teammate',
        // The owner themselves counts as 1, so we look for ≥ 2.
        done: (memberCount[0]?.n ?? 0) >= 2,
        href: '/members',
      },
      {
        key: 'stripe.connected',
        label: 'Connect Stripe (optional, for card payments)',
        done: stripeAcct.length > 0,
        href: '/settings/billing',
      },
    ];

    const checklist: OnboardingChecklist = {
      businessId,
      steps,
      complete: steps.every((s) => s.done),
    };
    res.json(checklist);
  }
}

/**
 * True when `err` (or anything in its `cause` chain) is a Postgres unique
 * violation, optionally for a specific constraint. Walks the chain because
 * drizzle re-throws driver errors wrapped in its own `Failed query: …`
 * error, which hides both the SQLSTATE and the constraint name.
 */
function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const UNIQUE_VIOLATION = '23505';
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const e = cur as { code?: string; constraint_name?: string; message?: string; cause?: unknown };
    const isUnique = e.code === UNIQUE_VIOLATION;
    const named =
      !constraint || e.constraint_name === constraint || (e.message ?? '').includes(constraint);
    if (isUnique && named) return true;
    if (constraint && (e.message ?? '').includes(constraint)) return true;
    cur = e.cause;
  }
  return false;
}
