import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { count, desc, eq, max, sql as raw } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { SYSTEM_ROLES } from '@jetnine/shared';
import { AuditService } from '../audit/audit.service';
import { DRIZZLE } from '../database/database.module';
import { CurrentUser, type CurrentUserPayload } from '../auth/current-user.decorator';
import { PLANS, type PlanId } from '../billing/pricing';
import { isReadOnly, type SubscriptionStatus } from '../billing/subscription-state';
import { isUniqueViolation } from '../common/db-errors';
import { SuperAdminOnly, TenantScoped } from '../tenancy/decorators';
import { InvitationService } from '../business/invitation.service';
import { TemplatesService, type TemplateSnapshot } from './templates.service';

const VALID_STATUSES = new Set(['active', 'suspended', 'trial', 'cancelled']);
const VALID_PLANS = new Set<string>(Object.keys(PLANS));

/**
 * `businesses.status` and `subscriptions.status` are two spellings of
 * the same fact, and SubscriptionGuard reads the subscriptions row
 * first. Every admin status change writes both so a super admin
 * flipping a business to "active" actually lifts the read-only mode.
 */
const SUBSCRIPTION_STATUS_FOR_BUSINESS_STATUS: Record<string, SubscriptionStatus> = {
  active: 'active',
  trial: 'trial',
  suspended: 'past_due',
  cancelled: 'canceled',
};

interface AdminSubscriptionView {
  businessId: string;
  plan: string;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  /** True when SubscriptionGuard is rejecting writes for this business. */
  readOnly: boolean;
}
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

interface BusinessSummary {
  id: string;
  slug: string;
  name: string;
  status: string;
  plan: string | null;
  createdAt: Date;
  userCount: number;
  locationCount: number;
  lastActivityAt: Date | null;
}

interface CreateBusinessBody {
  name?: string;
  slug?: string;
  ownerEmail?: string;
  ownerName?: string;
  plan?: string;
  /** Optional: stamp a business template onto the new business. */
  templateId?: string;
}

@SuperAdminOnly()
@TenantScoped()
@Controller('v1/admin/businesses')
export class AdminBusinessesController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(InvitationService) private readonly invitations: InvitationService,
    @Inject(TemplatesService) private readonly templates: TemplatesService,
  ) {}

  @Get()
  async list(): Promise<BusinessSummary[]> {
    const memberSubq = this.db
      .select({
        businessId: schema.memberships.businessId,
        userCount: count().as('member_count'),
      })
      .from(schema.memberships)
      .groupBy(schema.memberships.businessId)
      .as('m');

    const locationSubq = this.db
      .select({
        businessId: schema.locations.businessId,
        locationCount: count().as('location_count'),
      })
      .from(schema.locations)
      .groupBy(schema.locations.businessId)
      .as('l');

    const auditSubq = this.db
      .select({
        businessId: schema.auditLogs.businessId,
        lastActivityAt: max(schema.auditLogs.createdAt).as('last_activity_at'),
      })
      .from(schema.auditLogs)
      .groupBy(schema.auditLogs.businessId)
      .as('a');

    const rows = await this.db
      .select({
        id: schema.businesses.id,
        slug: schema.businesses.slug,
        name: schema.businesses.name,
        status: schema.businesses.status,
        plan: schema.businesses.plan,
        createdAt: schema.businesses.createdAt,
        userCount: memberSubq.userCount,
        locationCount: locationSubq.locationCount,
        lastActivityAt: auditSubq.lastActivityAt,
      })
      .from(schema.businesses)
      .leftJoin(memberSubq, eq(memberSubq.businessId, schema.businesses.id))
      .leftJoin(locationSubq, eq(locationSubq.businessId, schema.businesses.id))
      .leftJoin(auditSubq, eq(auditSubq.businessId, schema.businesses.id))
      .orderBy(desc(schema.businesses.createdAt));

    return rows.map((r) => ({
      ...r,
      userCount: Number(r.userCount ?? 0),
      locationCount: Number(r.locationCount ?? 0),
      lastActivityAt: r.lastActivityAt ?? null,
    }));
  }

  @Post()
  async create(
    @Body() body: CreateBusinessBody,
    @CurrentUser() actor: CurrentUserPayload,
  ): Promise<{ businessId: string; ownerUserId: string; inviteToken: string }> {
    const name = body.name?.trim();
    const slug = body.slug?.trim().toLowerCase();
    const ownerEmail = body.ownerEmail?.trim().toLowerCase();
    const ownerName = body.ownerName?.trim() ?? null;
    if (!name) throw new BadRequestException('name is required');
    if (!slug || !SLUG_RE.test(slug)) {
      throw new BadRequestException(
        'slug must be 1-64 chars, lowercase alphanumeric, may contain inner hyphens',
      );
    }
    if (!ownerEmail || !ownerEmail.includes('@')) {
      throw new BadRequestException('ownerEmail must be a valid email');
    }

    // 1. Create the business. New businesses start a 14-day trial unless
    // a paid plan was supplied at create time.
    const trialEndsAt = body.plan ? null : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const [biz] = await this.db
      .insert(schema.businesses)
      .values({
        slug,
        name,
        status: body.plan ? 'active' : 'trial',
        plan: body.plan ?? null,
        trialEndsAt,
      })
      .returning()
      .catch((err) => {
        if (isUniqueViolation(err, 'businesses_slug_uniq')) {
          throw new ConflictException(`A business with slug "${slug}" already exists`);
        }
        throw err;
      });
    if (!biz) throw new UnprocessableEntityException('failed to create business');

    // Seed the subscription row so SubscriptionGuard has something to
    // read on the very first request.
    await this.db.insert(schema.subscriptions).values({
      businessId: biz.id,
      plan: body.plan ?? 'starter',
      status: body.plan ? 'active' : 'trial',
      trialEndsAt,
    });

    // 2. Seed system roles + their permissions for this business.
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

    // 2b. Create-from-template (platform layer): stamp the chosen
    // template's config on top of the system seed.
    if (body.templateId) {
      const [tpl] = await this.db
        .select()
        .from(schema.businessTemplates)
        .where(eq(schema.businessTemplates.id, body.templateId))
        .limit(1);
      if (!tpl) throw new BadRequestException('templateId does not exist');
      await this.templates.applyTemplate(biz.id, tpl.snapshotJson as TemplateSnapshot);
    }

    // 3. Invite the owner via the shared service (creates user, opens
    // membership, mints token, sends email).
    const invite = await this.invitations.invite({
      businessId: biz.id,
      businessName: biz.name,
      email: ownerEmail,
      name: ownerName,
      roleId: ownerRoleId,
      invitedByUserId: actor.id,
    });

    await this.audit.log({
      action: 'business.create',
      targetType: 'business',
      targetId: biz.id,
      after: { slug, name, status: biz.status, ownerEmail },
    });

    return { businessId: biz.id, ownerUserId: invite.userId, inviteToken: invite.token };
  }

  @Patch(':id/status')
  async setStatus(
    @Param('id') id: string,
    @Body('status') status: string | undefined,
  ): Promise<BusinessSummary> {
    if (!status || !VALID_STATUSES.has(status)) {
      throw new BadRequestException(`status must be one of: ${[...VALID_STATUSES].join(', ')}`);
    }

    const [existing] = await this.db
      .select()
      .from(schema.businesses)
      .where(eq(schema.businesses.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException('Business not found');

    const now = new Date();
    const [updated] = await this.db
      .update(schema.businesses)
      .set({
        status,
        // An admin-activated business has no trial to expire.
        ...(status === 'active' ? { trialEndsAt: null } : {}),
        updatedAt: now,
      })
      .where(eq(schema.businesses.id, id))
      .returning();
    if (!updated) throw new NotFoundException('Business not found after update');

    // Mirror onto the subscriptions row (the column the guard reads
    // first). Businesses created before the subscriptions table existed
    // have no row; the guard falls back to businesses.status for those,
    // so only rows that exist are touched here.
    const subStatus = SUBSCRIPTION_STATUS_FOR_BUSINESS_STATUS[status];
    if (subStatus) {
      await this.db
        .update(schema.subscriptions)
        .set({
          status: subStatus,
          ...(subStatus === 'active' ? { trialEndsAt: null, cancelAtPeriodEnd: null } : {}),
          updatedAt: now,
        })
        .where(eq(schema.subscriptions.businessId, id));
    }

    await this.audit.log({
      action: 'business.status.update',
      targetType: 'business',
      targetId: updated.id,
      before: { status: existing.status },
      after: { status: updated.status },
    });

    return {
      id: updated.id,
      slug: updated.slug,
      name: updated.name,
      status: updated.status,
      plan: updated.plan ?? null,
      createdAt: updated.createdAt,
      userCount: 0,
      locationCount: 0,
      lastActivityAt: null,
    };
  }

  @Get(':id/subscription')
  async getSubscription(@Param('id') id: string): Promise<AdminSubscriptionView> {
    return this.subscriptionView(id);
  }

  /**
   * Put a business on a paid plan with no end date. The platform
   * billing model is being transitioned, so self-serve subscribe is
   * paused and the super admin sets plans by hand; this is the switch
   * that lifts the trial-expiry read-only mode.
   *
   * Unlike the tenant-side subscribe endpoint, no billing period is
   * written: `trial_ends_at`, `current_period_end`, and
   * `cancel_at_period_end` are all cleared, so nothing can flip the
   * business back to read-only later on.
   */
  @Patch(':id/subscription')
  async activateSubscription(
    @Param('id') id: string,
    @Body() body: { plan?: string } | undefined,
  ): Promise<AdminSubscriptionView> {
    const [existing] = await this.db
      .select()
      .from(schema.businesses)
      .where(eq(schema.businesses.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException('Business not found');

    const [existingSub] = await this.db
      .select({ plan: schema.subscriptions.plan, status: schema.subscriptions.status })
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.businessId, id))
      .limit(1);

    const requested = body?.plan;
    if (requested !== undefined && !VALID_PLANS.has(requested)) {
      throw new BadRequestException(`plan must be one of: ${[...VALID_PLANS].join(', ')}`);
    }
    const fallback = existingSub?.plan ?? existing.plan ?? 'starter';
    const plan = (requested ?? (VALID_PLANS.has(fallback) ? fallback : 'starter')) as PlanId;

    const [locRow] = await this.db
      .select({ locationCount: count() })
      .from(schema.locations)
      .where(eq(schema.locations.businessId, id));
    const locationCount = locRow?.locationCount ?? 0;

    const now = new Date();
    await this.db
      .insert(schema.subscriptions)
      .values({
        businessId: id,
        plan,
        status: 'active',
        trialEndsAt: null,
        currentPeriodStart: now,
        currentPeriodEnd: null,
        paidLocationCount: Number(locationCount),
      })
      .onConflictDoUpdate({
        target: schema.subscriptions.businessId,
        set: {
          plan,
          status: 'active',
          trialEndsAt: null,
          currentPeriodStart: now,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: null,
          paidLocationCount: Number(locationCount),
          updatedAt: now,
        },
      });
    await this.db
      .update(schema.businesses)
      .set({ status: 'active', plan, trialEndsAt: null, updatedAt: now })
      .where(eq(schema.businesses.id, id));

    await this.audit.log({
      action: 'business.subscription.activate',
      targetType: 'business',
      targetId: id,
      before: {
        status: existing.status,
        plan: existing.plan ?? null,
        subscriptionStatus: existingSub?.status ?? null,
      },
      after: { status: 'active', plan, subscriptionStatus: 'active', endsAt: null },
    });

    return this.subscriptionView(id);
  }

  private async subscriptionView(businessId: string): Promise<AdminSubscriptionView> {
    const [sub] = await this.db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.businessId, businessId))
      .limit(1);
    if (sub) {
      const status = sub.status as SubscriptionStatus;
      return {
        businessId,
        plan: sub.plan,
        status,
        trialEndsAt: sub.trialEndsAt,
        currentPeriodEnd: sub.currentPeriodEnd,
        readOnly: isReadOnly(status, sub.trialEndsAt),
      };
    }
    // No subscriptions row: same fallback SubscriptionGuard applies.
    const [biz] = await this.db
      .select({
        status: schema.businesses.status,
        plan: schema.businesses.plan,
        trialEndsAt: schema.businesses.trialEndsAt,
      })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    if (!biz) throw new NotFoundException('Business not found');
    const status = (SUBSCRIPTION_STATUS_FOR_BUSINESS_STATUS[biz.status] ??
      'trial') as SubscriptionStatus;
    return {
      businessId,
      plan: biz.plan ?? 'starter',
      status,
      trialEndsAt: biz.trialEndsAt,
      currentPeriodEnd: null,
      readOnly: isReadOnly(status, biz.trialEndsAt),
    };
  }
}

// Suppress unused-import lint warnings for the count/raw helpers if a future
// refactor drops them.
void raw;
