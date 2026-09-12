import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { BUSINESS_PERMISSIONS, type Permission } from '@jetnine/shared';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant, CurrentUser } from '../auth/current-user.decorator';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { InvitationService } from './invitation.service';

interface MemberRow {
  membershipId: string;
  userId: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  commissionPlanId?: string | null;
  status: string;
  roleId: string;
  roleName: string;
  dataScope: string;
  sellingScope: string;
  managerDashboard: boolean;
  monthlyGoalCents: number | null;
  scopeLocationIds: string[];
  hiddenNav: string[];
  invitedAt: Date | null;
  acceptedAt: Date | null;
}

interface InviteBody {
  email?: string;
  name?: string;
  roleId?: string;
  roleName?: string;
}

interface UpdateMemberBody {
  roleId?: string;
  status?: 'active' | 'disabled';
  /** Sales-data visibility: 'store' limits sales surfaces to scopeLocationIds. */
  dataScope?: 'all' | 'store';
  /** Selling rights: 'approved' limits ringing sales to scopeLocationIds. */
  sellingScope?: 'all' | 'approved';
  managerDashboard?: boolean;
  monthlyGoalCents?: number | null;
  /** Replaces the member's location scope set (only meaningful with 'store'). */
  scopeLocationIds?: string[];
  /** Left-nav hrefs hidden for this member (visibility only; permissions still gate the API). */
  hiddenNav?: string[];
}

interface MemberAccess {
  membershipId: string;
  roleId: string;
  roleName: string;
  rolePermissions: Permission[];
  overrides: { permission: Permission; allowed: boolean }[];
  effective: Permission[];
}

const VALID_STATUS_TARGETS = new Set(['active', 'disabled']);

@TenantScoped()
@Controller('v1/business/members')
export class MembersController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(InvitationService) private readonly invitations: InvitationService,
  ) {}

  @Get()
  @RequirePermission('users.view')
  async list(@CurrentTenant() tenant: RequestTenantContext): Promise<MemberRow[]> {
    const rows = await this.db
      .select({
        membershipId: schema.memberships.id,
        userId: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        emailVerified: schema.users.emailVerified,
        status: schema.memberships.status,
        roleId: schema.roles.id,
        roleName: schema.roles.name,
        invitedAt: schema.memberships.invitedAt,
        acceptedAt: schema.memberships.acceptedAt,
        dataScope: schema.memberships.dataScope,
        sellingScope: schema.memberships.sellingScope,
        managerDashboard: schema.memberships.managerDashboard,
        monthlyGoalCents: schema.memberships.monthlyGoalCents,
        hiddenNavJson: schema.memberships.hiddenNavJson,
        // Lets the commissions page show who is currently on a plan.
        commissionPlanId: schema.memberships.commissionPlanId,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .innerJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
      .where(
        and(
          eq(schema.memberships.businessId, tenant.businessId!),
          // Removed members (owner 2026-09-02) keep their row for history
          // but leave the roster.
          ne(schema.memberships.status, 'removed'),
        ),
      );
    const scopes = await this.db
      .select({
        membershipId: schema.membershipLocationScopes.membershipId,
        locationId: schema.membershipLocationScopes.locationId,
      })
      .from(schema.membershipLocationScopes)
      .where(eq(schema.membershipLocationScopes.businessId, tenant.businessId!));
    const byMembership = new Map<string, string[]>();
    for (const sRow of scopes) {
      const list = byMembership.get(sRow.membershipId) ?? [];
      list.push(sRow.locationId);
      byMembership.set(sRow.membershipId, list);
    }
    return rows.map(({ hiddenNavJson, ...r }) => ({
      ...r,
      scopeLocationIds: byMembership.get(r.membershipId) ?? [],
      hiddenNav: Array.isArray(hiddenNavJson) ? (hiddenNavJson as string[]) : [],
    }));
  }

  /**
   * The calling member's own access snapshot — what the app shell needs
   * to shape itself: which nav tabs are hidden for them and which
   * locations their selling/data scope covers. No permission required:
   * it only describes the caller's own membership.
   */
  @Get('me')
  async me(@CurrentTenant() tenant: RequestTenantContext): Promise<{
    membershipId: string | null;
    dataScope: 'all' | 'store';
    sellingScope: 'all' | 'approved';
    scopeLocationIds: string[] | null;
    /** The approved stores WITH names — the login store picker renders these. */
    scopeLocations: { id: string; name: string }[];
    hiddenNav: string[];
    roleName: string | null;
    managerDashboard: boolean;
    /**
     * Whether /dashboard opens on the Operations home. Keyed to the role
     * name, not to `ops.dashboard.view`: Owner and Manager hold every
     * business permission by construction, so gating on the permission
     * would replace their home too. They still reach the page at
     * /operations — the permission governs access, the role governs
     * which home you land on.
     */
    operationsDashboard: boolean;
    /** Same pattern for the Warehouse role's home (§12.2). */
    warehouseDashboard: boolean;
    /** And the Cashier's My Day (§12.3). */
    cashierDashboard: boolean;
    canDeleteMembers: boolean;
  }> {
    let hiddenNav: string[] = [];
    let managerDashboard = false;
    let scopeLocations: { id: string; name: string }[] = [];
    if (tenant.membershipId) {
      const [row] = await this.db
        .select({
          hiddenNavJson: schema.memberships.hiddenNavJson,
          managerDashboard: schema.memberships.managerDashboard,
        })
        .from(schema.memberships)
        .where(eq(schema.memberships.id, tenant.membershipId))
        .limit(1);
      if (row && Array.isArray(row.hiddenNavJson)) hiddenNav = row.hiddenNavJson as string[];
      managerDashboard = row?.managerDashboard ?? false;
      scopeLocations = await this.db
        .select({ id: schema.locations.id, name: schema.locations.name })
        .from(schema.membershipLocationScopes)
        .innerJoin(
          schema.locations,
          eq(schema.locations.id, schema.membershipLocationScopes.locationId),
        )
        .where(eq(schema.membershipLocationScopes.membershipId, tenant.membershipId))
        .orderBy(schema.locations.name);
    }
    return {
      membershipId: tenant.membershipId,
      dataScope: tenant.dataScope,
      sellingScope: tenant.sellingScope,
      scopeLocationIds: tenant.scopeLocationIds,
      scopeLocations,
      hiddenNav,
      /** Redesign 2026-09-04: the shell shows the role badge and, for Owners, the role-home switch. */
      roleName: tenant.roleName,
      managerDashboard,
      operationsDashboard:
        tenant.roleName === 'Operations' && tenant.permissions.has('ops.dashboard.view'),
      warehouseDashboard:
        tenant.roleName === 'Warehouse' && tenant.permissions.has('warehouse.dashboard.view'),
      cashierDashboard:
        tenant.roleName === 'Cashier' && tenant.permissions.has('cashier.dashboard.view'),
      /** Owner 2026-09-02: the Members page shows Delete only to who may. */
      canDeleteMembers: tenant.permissions.has('users.delete'),
    };
  }

  @Post('invite')
  @RequirePermission('users.invite')
  async invite(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Body() body: InviteBody,
  ): Promise<{
    membershipId: string;
    userId: string;
    alreadyMember: boolean;
    inviteLink?: string;
  }> {
    const email = body.email?.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      throw new BadRequestException('email is required');
    }

    const roleId = await this.resolveRoleId(tenant.businessId!, body.roleId, body.roleName);
    const business = await this.loadBusinessName(tenant.businessId!);

    const result = await this.invitations.invite({
      businessId: tenant.businessId!,
      businessName: business,
      email,
      name: body.name ?? null,
      roleId,
      invitedByUserId: actor.id,
    });

    await this.audit.log({
      action: result.alreadyMember ? 'membership.invite.skipped' : 'membership.invite',
      targetType: 'membership',
      targetId: result.membershipId,
      metadata: { email, roleId, alreadyMember: result.alreadyMember },
    });

    return {
      membershipId: result.membershipId,
      userId: result.userId,
      alreadyMember: result.alreadyMember,
      // Only when the mail could not actually be delivered: without this
      // the inviter is told "invitation sent" and the invitee never hears
      // from us, which is a dead end with no way out of the UI. The caller
      // already holds `users.invite`, so handing them the link they were
      // going to email grants nothing extra.
      ...(result.link && !result.emailDelivered ? { inviteLink: result.link } : {}),
    };
  }

  @Post(':id/resend-invite')
  @RequirePermission('users.invite')
  async resend(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload,
    @Param('id') membershipId: string,
  ): Promise<{ resent: true; inviteLink?: string }> {
    const [m] = await this.db
      .select({
        id: schema.memberships.id,
        userId: schema.memberships.userId,
        roleId: schema.memberships.roleId,
        status: schema.memberships.status,
        email: schema.users.email,
        name: schema.users.name,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(
        and(
          eq(schema.memberships.id, membershipId),
          eq(schema.memberships.businessId, tenant.businessId!),
        ),
      )
      .limit(1);
    if (!m) throw new NotFoundException('Membership not found');
    if (m.status === 'active') {
      throw new ConflictException('Member is already active');
    }
    const business = await this.loadBusinessName(tenant.businessId!);
    const result = await this.invitations.invite({
      businessId: tenant.businessId!,
      businessName: business,
      email: m.email,
      name: m.name,
      roleId: m.roleId,
      invitedByUserId: actor.id,
    });
    await this.audit.log({
      action: 'membership.invite.resend',
      targetType: 'membership',
      targetId: m.id,
      metadata: { email: m.email, emailDelivered: result.emailDelivered },
    });
    return {
      resent: true,
      ...(result.link && !result.emailDelivered ? { inviteLink: result.link } : {}),
    };
  }

  /**
   * Redesign Phase 3 (README §2): the "Acting for {Store}" chip. The choice
   * itself lives in the browser session; this records the switch in the
   * audit log so a drawer or report attributed to a store can be traced
   * to the person who pointed their register at it.
   */
  @Post('me/acting-store')
  async actingStore(
    @CurrentTenant() tenant: RequestTenantContext,
    @Body() body: { locationId?: string; previousLocationId?: string | null },
  ): Promise<{ ok: true }> {
    const locationId = typeof body?.locationId === 'string' ? body.locationId : '';
    if (!locationId) throw new BadRequestException('locationId is required');
    const [loc] = await this.db
      .select({ id: schema.locations.id, name: schema.locations.name })
      .from(schema.locations)
      .where(
        and(
          eq(schema.locations.id, locationId),
          eq(schema.locations.businessId, tenant.businessId!),
        ),
      )
      .limit(1);
    if (!loc) throw new NotFoundException('Location not found');
    if (
      tenant.sellingScope === 'approved' &&
      !(tenant.scopeLocationIds ?? []).includes(locationId)
    ) {
      throw new ForbiddenException('You are not approved to sell at that store');
    }
    await this.audit.log({
      action: 'membership.acting_store',
      targetType: 'membership',
      targetId: tenant.membershipId ?? undefined,
      metadata: {
        locationId: loc.id,
        locationName: loc.name,
        previousLocationId:
          typeof body.previousLocationId === 'string' ? body.previousLocationId : null,
      },
    });
    return { ok: true };
  }

  @Patch(':id')
  @RequirePermission('users.update')
  async update(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') membershipId: string,
    @Body() body: UpdateMemberBody,
  ): Promise<{ updated: true }> {
    const [existing] = await this.db
      .select()
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.id, membershipId),
          eq(schema.memberships.businessId, tenant.businessId!),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException('Membership not found');

    const update: Partial<typeof schema.memberships.$inferInsert> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (body.roleId && body.roleId !== existing.roleId) {
      const [role] = await this.db
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(
          and(eq(schema.roles.id, body.roleId), eq(schema.roles.businessId, tenant.businessId!)),
        )
        .limit(1);
      if (!role) throw new NotFoundException('Role not found in this business');
      update.roleId = body.roleId;
      before.roleId = existing.roleId;
      after.roleId = body.roleId;
    }

    if (body.status && body.status !== existing.status) {
      if (!VALID_STATUS_TARGETS.has(body.status)) {
        throw new BadRequestException('status must be active or disabled');
      }
      update.status = body.status;
      before.status = existing.status;
      after.status = body.status;
    }

    if (body.dataScope && body.dataScope !== existing.dataScope) {
      if (body.dataScope !== 'all' && body.dataScope !== 'store') {
        throw new BadRequestException('dataScope must be all or store');
      }
      update.dataScope = body.dataScope;
      before.dataScope = existing.dataScope;
      after.dataScope = body.dataScope;
    }

    if (body.sellingScope && body.sellingScope !== existing.sellingScope) {
      if (body.sellingScope !== 'all' && body.sellingScope !== 'approved') {
        throw new BadRequestException('sellingScope must be all or approved');
      }
      update.sellingScope = body.sellingScope;
      before.sellingScope = existing.sellingScope;
      after.sellingScope = body.sellingScope;
    }

    if (
      body.managerDashboard !== undefined &&
      body.managerDashboard !== existing.managerDashboard
    ) {
      if (typeof body.managerDashboard !== 'boolean') {
        throw new BadRequestException('managerDashboard must be a boolean');
      }
      update.managerDashboard = body.managerDashboard;
      before.managerDashboard = existing.managerDashboard;
      after.managerDashboard = body.managerDashboard;
    }

    if (
      body.monthlyGoalCents !== undefined &&
      body.monthlyGoalCents !== existing.monthlyGoalCents
    ) {
      if (
        body.monthlyGoalCents !== null &&
        (!Number.isInteger(body.monthlyGoalCents) || body.monthlyGoalCents < 0)
      ) {
        throw new BadRequestException('monthlyGoalCents must be a non-negative integer or null');
      }
      update.monthlyGoalCents = body.monthlyGoalCents;
      before.monthlyGoalCents = existing.monthlyGoalCents;
      after.monthlyGoalCents = body.monthlyGoalCents;
    }

    if (body.hiddenNav !== undefined) {
      if (
        !Array.isArray(body.hiddenNav) ||
        body.hiddenNav.some((h) => typeof h !== 'string' || !h.startsWith('/'))
      ) {
        throw new BadRequestException('hiddenNav must be an array of nav hrefs (e.g. ["/gl"])');
      }
      const cleaned = [...new Set(body.hiddenNav)];
      update.hiddenNavJson = cleaned as never;
      before.hiddenNav = existing.hiddenNavJson;
      after.hiddenNav = cleaned;
    }

    let scopeChange: string[] | null = null;
    if (body.scopeLocationIds !== undefined) {
      if (!Array.isArray(body.scopeLocationIds)) {
        throw new BadRequestException('scopeLocationIds must be an array');
      }
      const ids = [...new Set(body.scopeLocationIds)];
      if (ids.length > 0) {
        const found = await this.db
          .select({ id: schema.locations.id })
          .from(schema.locations)
          .where(
            and(
              inArray(schema.locations.id, ids),
              eq(schema.locations.businessId, tenant.businessId!),
            ),
          );
        if (found.length !== ids.length) {
          throw new BadRequestException('One or more locations not found in this business');
        }
      }
      scopeChange = ids;
      before.scopeLocationIds = undefined; // filled below from current rows
      after.scopeLocationIds = ids;
    }

    if (Object.keys(update).length === 0 && scopeChange === null) {
      throw new BadRequestException('Nothing to update');
    }

    if (scopeChange !== null) {
      const current = await this.db
        .select({ locationId: schema.membershipLocationScopes.locationId })
        .from(schema.membershipLocationScopes)
        .where(eq(schema.membershipLocationScopes.membershipId, membershipId));
      before.scopeLocationIds = current.map((c) => c.locationId);
      await this.db
        .delete(schema.membershipLocationScopes)
        .where(eq(schema.membershipLocationScopes.membershipId, membershipId));
      if (scopeChange.length > 0) {
        await this.db.insert(schema.membershipLocationScopes).values(
          scopeChange.map((locationId) => ({
            membershipId,
            locationId,
            businessId: tenant.businessId!,
          })),
        );
      }
    }

    if (Object.keys(update).length > 0) {
      await this.db
        .update(schema.memberships)
        .set(update)
        .where(eq(schema.memberships.id, membershipId));
    }

    await this.audit.log({
      action: 'membership.update',
      targetType: 'membership',
      targetId: membershipId,
      before,
      after,
    });

    return { updated: true };
  }

  @Post(':id/disable')
  @RequirePermission('users.disable')
  async disable(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') membershipId: string,
  ): Promise<{ disabled: true }> {
    const [existing] = await this.db
      .select()
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.id, membershipId),
          eq(schema.memberships.businessId, tenant.businessId!),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException('Membership not found');
    if (existing.status === 'disabled') return { disabled: true };

    await this.db
      .update(schema.memberships)
      .set({ status: 'disabled' })
      .where(eq(schema.memberships.id, membershipId));

    await this.audit.log({
      action: 'membership.disable',
      targetType: 'membership',
      targetId: membershipId,
      before: { status: existing.status },
      after: { status: 'disabled' },
    });

    return { disabled: true };
  }

  /**
   * Delete a member (owner 2026-09-02). Two outcomes, one button: a
   * membership nothing refers to yet (a mistaken invite, a never-used
   * seat) is deleted outright; one that has written orders, driven
   * deliveries, earned commission or left notes is removed from the
   * roster and locked out, but its row stays so every document keeps
   * its name. Never yourself, never the last active Owner.
   */
  @Delete(':id')
  @RequirePermission('users.delete')
  async remove(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') membershipId: string,
  ): Promise<{ removed: true; mode: 'deleted' | 'archived' }> {
    const [existing] = await this.db
      .select({
        id: schema.memberships.id,
        userId: schema.memberships.userId,
        status: schema.memberships.status,
        roleName: schema.roles.name,
      })
      .from(schema.memberships)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
      .where(
        and(
          eq(schema.memberships.id, membershipId),
          eq(schema.memberships.businessId, tenant.businessId!),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException('Membership not found');
    if (existing.id === tenant.membershipId) {
      throw new BadRequestException('You cannot delete your own membership');
    }
    if (existing.roleName === 'Owner') {
      const [owners] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.memberships)
        .innerJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
        .where(
          and(
            eq(schema.memberships.businessId, tenant.businessId!),
            eq(schema.roles.name, 'Owner'),
            eq(schema.memberships.status, 'active'),
            ne(schema.memberships.id, membershipId),
          ),
        );
      if ((owners?.n ?? 0) === 0) {
        throw new ForbiddenException('The business needs at least one active Owner');
      }
    }

    // Anything that names this membership: attribution and money that
    // must survive the person leaving.
    const [refs] = (await this.db.execute(sql`
      SELECT
        (SELECT count(*) FROM orders WHERE salesperson_membership_id = ${membershipId} OR second_salesperson_membership_id = ${membershipId})
        + (SELECT count(*) FROM deliveries WHERE driver_membership_id = ${membershipId})
        + (SELECT count(*) FROM delivery_runs WHERE driver_membership_id = ${membershipId})
        + (SELECT count(*) FROM service_orders WHERE technician_membership_id = ${membershipId})
        + (SELECT count(*) FROM commission_entries WHERE membership_id = ${membershipId})
        + (SELECT count(*) FROM order_notes WHERE author_membership_id = ${membershipId})
        + (SELECT count(*) FROM order_returns WHERE created_by_user_id = ${existing.userId})
        + (SELECT count(*) FROM sales WHERE associate_user_id = ${existing.userId})
        AS n`)) as unknown as { n: string | number }[];
    const history = Number(refs?.n ?? 0);

    if (history > 0) {
      await this.db
        .update(schema.memberships)
        .set({ status: 'removed' })
        .where(eq(schema.memberships.id, membershipId));
      await this.db
        .delete(schema.membershipLocationScopes)
        .where(eq(schema.membershipLocationScopes.membershipId, membershipId));
      await this.audit.log({
        action: 'membership.remove',
        targetType: 'membership',
        targetId: membershipId,
        before: { status: existing.status, roleName: existing.roleName },
        after: { status: 'removed', history },
      });
      return { removed: true, mode: 'archived' };
    }

    await this.db.delete(schema.memberships).where(eq(schema.memberships.id, membershipId));
    await this.audit.log({
      action: 'membership.delete',
      targetType: 'membership',
      targetId: membershipId,
      before: { status: existing.status, roleName: existing.roleName, userId: existing.userId },
      after: null,
    });
    return { removed: true, mode: 'deleted' };
  }

  /**
   * The member's access sheet: what the role grants, what this member's
   * overrides change, and the effective result the guard will enforce
   * (role permissions + allowed:true rows − allowed:false rows).
   */
  @Get(':id/permissions')
  @RequirePermission('users.view')
  async permissions(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') membershipId: string,
  ): Promise<MemberAccess> {
    const m = await this.loadMembership(tenant.businessId!, membershipId);
    const [roleRows, overrideRows] = await Promise.all([
      this.db
        .select({ permission: schema.rolePermissions.permission })
        .from(schema.rolePermissions)
        .where(eq(schema.rolePermissions.roleId, m.roleId)),
      this.db
        .select({
          permission: schema.membershipPermissionOverrides.permission,
          allowed: schema.membershipPermissionOverrides.allowed,
        })
        .from(schema.membershipPermissionOverrides)
        .where(eq(schema.membershipPermissionOverrides.membershipId, membershipId)),
    ]);
    const rolePermissions = roleRows.map((r) => r.permission as Permission).sort();
    const overrides = overrideRows
      .map((o) => ({ permission: o.permission as Permission, allowed: o.allowed }))
      .sort((a, b) => a.permission.localeCompare(b.permission));
    const effective = new Set<Permission>(rolePermissions);
    for (const o of overrides) {
      if (o.allowed) effective.add(o.permission);
      else effective.delete(o.permission);
    }
    return {
      membershipId,
      roleId: m.roleId,
      roleName: m.roleName,
      rolePermissions,
      overrides,
      effective: [...effective].sort(),
    };
  }

  /**
   * Replace the member's override set. Overrides are stored as diffs
   * against the role: an entry equal to what the role already says is
   * dropped (so switching roles later re-inherits cleanly), and unknown
   * or super-admin permissions are rejected outright.
   */
  @Put(':id/permissions')
  @RequirePermission('users.update')
  async setPermissions(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') membershipId: string,
    @Body() body: { overrides?: { permission?: string; allowed?: boolean }[] },
  ): Promise<MemberAccess> {
    const m = await this.loadMembership(tenant.businessId!, membershipId);
    if (!Array.isArray(body.overrides)) {
      throw new BadRequestException('overrides must be an array');
    }
    const valid = new Set<string>(BUSINESS_PERMISSIONS);
    const wanted = new Map<Permission, boolean>();
    for (const o of body.overrides) {
      if (!o || typeof o.permission !== 'string' || typeof o.allowed !== 'boolean') {
        throw new BadRequestException('each override needs { permission, allowed }');
      }
      if (!valid.has(o.permission)) {
        throw new BadRequestException(`Unknown or non-grantable permission: ${o.permission}`);
      }
      if (wanted.has(o.permission as Permission)) {
        throw new BadRequestException(`Duplicate override for ${o.permission}`);
      }
      wanted.set(o.permission as Permission, o.allowed);
    }

    const roleRows = await this.db
      .select({ permission: schema.rolePermissions.permission })
      .from(schema.rolePermissions)
      .where(eq(schema.rolePermissions.roleId, m.roleId));
    const roleHas = new Set(roleRows.map((r) => r.permission));
    // Keep only real diffs against the role.
    for (const [permission, allowed] of [...wanted]) {
      if (roleHas.has(permission) === allowed) wanted.delete(permission);
    }

    const current = await this.db
      .select({
        permission: schema.membershipPermissionOverrides.permission,
        allowed: schema.membershipPermissionOverrides.allowed,
      })
      .from(schema.membershipPermissionOverrides)
      .where(eq(schema.membershipPermissionOverrides.membershipId, membershipId));

    await this.db
      .delete(schema.membershipPermissionOverrides)
      .where(eq(schema.membershipPermissionOverrides.membershipId, membershipId));
    if (wanted.size > 0) {
      await this.db.insert(schema.membershipPermissionOverrides).values(
        [...wanted].map(([permission, allowed]) => ({
          businessId: tenant.businessId!,
          membershipId,
          permission,
          allowed,
        })),
      );
    }

    await this.audit.log({
      action: 'membership.permissions.update',
      targetType: 'membership',
      targetId: membershipId,
      before: {
        overrides: current
          .map((c) => ({ permission: c.permission, allowed: c.allowed }))
          .sort((a, b) => a.permission.localeCompare(b.permission)),
      },
      after: {
        overrides: [...wanted]
          .map(([permission, allowed]) => ({ permission, allowed }))
          .sort((a, b) => a.permission.localeCompare(b.permission)),
      },
    });

    return this.permissions(tenant, membershipId);
  }

  private async loadMembership(
    businessId: string,
    membershipId: string,
  ): Promise<{ roleId: string; roleName: string }> {
    const [m] = await this.db
      .select({ roleId: schema.memberships.roleId, roleName: schema.roles.name })
      .from(schema.memberships)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
      .where(
        and(eq(schema.memberships.id, membershipId), eq(schema.memberships.businessId, businessId)),
      )
      .limit(1);
    if (!m) throw new NotFoundException('Membership not found');
    return m;
  }

  private async resolveRoleId(
    businessId: string,
    roleId: string | undefined,
    roleName: string | undefined,
  ): Promise<string> {
    if (roleId) {
      const [r] = await this.db
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(and(eq(schema.roles.id, roleId), eq(schema.roles.businessId, businessId)))
        .limit(1);
      if (!r) throw new NotFoundException('Role not found in this business');
      return r.id;
    }
    if (roleName) {
      const [r] = await this.db
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(and(eq(schema.roles.name, roleName), eq(schema.roles.businessId, businessId)))
        .limit(1);
      if (!r) throw new NotFoundException(`Role "${roleName}" not found in this business`);
      return r.id;
    }
    throw new BadRequestException('roleId or roleName is required');
  }

  private async loadBusinessName(businessId: string): Promise<string> {
    const [b] = await this.db
      .select({ name: schema.businesses.name })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    return b?.name ?? 'LA Mattress ERP';
  }
}
