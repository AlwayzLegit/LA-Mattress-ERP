import {
  CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  PreconditionFailedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import type { Permission } from '@jetnine/shared';
import type { Request, Response } from 'express';
import { DRIZZLE } from '../database/database.module';
import { activeBusinessCookieOptions } from './active-business-cookie';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import { IS_PUBLIC_KEY, IS_SUPER_ADMIN_ONLY_KEY } from './decorators';
import type { RequestTenantContext } from './request-context';

export const ACTIVE_BUSINESS_COOKIE = 'jetnine.active_business_id';
export const ACTIVE_BUSINESS_HEADER = 'x-business-id';

/**
 * Resolves the active business for the current request and loads the user's
 * permissions for it. Runs after AuthGuard, so `req.user` is populated.
 *
 * The active business is read from (in order):
 *   1. The X-Business-Id header (mostly for tests + machine clients)
 *   2. The jetnine.active_business_id cookie (set by POST /v1/auth/active-business)
 *
 * If the user holds no membership for that business, this guard 403s. With
 * nothing selected, a user who belongs to exactly one business is simply
 * in it (and the cookie is set again); only someone with several gets 412
 * (Precondition Failed) so the client shows the "pick a business" picker
 * (PLAN.md: "a user picks a business after login if they belong to
 * multiple").
 *
 * Routes marked @SuperAdminOnly() bypass tenant resolution entirely (super
 * admins do platform-level work; their tenant context is empty).
 */
@Injectable()
export class TenancyGuard implements CanActivate {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<
      Request & {
        user?: CurrentUserPayload;
        tenant?: RequestTenantContext;
        apiKey?: { id: string; businessId: string; scopes: string[]; name: string };
      }
    >();

    const ip = readIp(req);
    const userAgent = readUserAgent(req);

    // API-key requests have no human user; the key already names a single
    // business and carries its own scopes. Skip the membership lookup
    // and synthesize a tenant context directly from the key.
    if (req.apiKey) {
      req.tenant = {
        userId: null,
        isSuperAdmin: false,
        businessId: req.apiKey.businessId,
        membershipId: null,
        roleId: null,
        roleName: `api_key:${req.apiKey.name}`,
        permissions: new Set<Permission>(req.apiKey.scopes as Permission[]),
        ip,
        userAgent,
        impersonatorUserId: null,
        apiKeyId: req.apiKey.id,
        dataScope: 'all',
        sellingScope: 'all',
        scopeLocationIds: null,
        auditLogged: false,
      };
      return true;
    }

    const user = req.user;
    if (!user) {
      // AuthGuard should have run first; if it didn't, fail closed.
      throw new ForbiddenException('Not signed in');
    }

    const superAdminOnly = this.reflector.getAllAndOverride<boolean>(IS_SUPER_ADMIN_ONLY_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const impersonatorUserId = user.impersonatorUserId;

    if (superAdminOnly) {
      if (!user.isSuperAdmin) throw new ForbiddenException('Super-admin only');
      req.tenant = emptyTenantContext(user, ip, userAgent, impersonatorUserId);
      return true;
    }

    let businessId = pickActiveBusinessId(req);
    let membershipCount = 0;
    if (!businessId && !user.isSuperAdmin) {
      // The active-business cookie expires (30 days) while the session
      // keeps renewing, which left signed-in staff on "No active business
      // selected" everywhere (owner 2026-09-28). One business → use it.
      const ids = await this.activeBusinessIds(user.id);
      membershipCount = ids.length;
      const only = ids.length === 1 ? ids[0]! : null;
      if (only) {
        businessId = only;
        const res = ctx.switchToHttp().getResponse<Response>();
        res.cookie?.(
          ACTIVE_BUSINESS_COOKIE,
          only,
          activeBusinessCookieOptions(process.env.NODE_ENV === 'production'),
        );
      }
    }
    if (!businessId) {
      // For super admins we still let them through with an empty tenant
      // context — they may be calling super-admin-only endpoints from a UI
      // that hasn't selected a business yet.
      if (user.isSuperAdmin) {
        req.tenant = emptyTenantContext(user, ip, userAgent, impersonatorUserId);
        return true;
      }
      // `code` tells the web client what to do: several businesses → send
      // them to the picker; none yet (a fresh sign-up) → leave the page
      // alone, /welcome's create-a-business flow is theirs to open.
      throw new PreconditionFailedException({
        statusCode: 412,
        error: 'Precondition Failed',
        message: 'No active business selected. POST /v1/auth/active-business first.',
        code: membershipCount > 1 ? 'BUSINESS_NOT_SELECTED' : 'NO_BUSINESS',
      });
    }

    const membership = await this.loadMembership(user.id, businessId);
    if (!membership) {
      // Super admins may operate on any business via impersonation; load
      // permissions as if they had the Owner role-equivalent (all perms).
      // For now we just give them an empty permission set and rely on the
      // is_super_admin flag to bypass per-permission checks downstream.
      if (user.isSuperAdmin) {
        req.tenant = {
          userId: user.id,
          isSuperAdmin: true,
          businessId,
          membershipId: null,
          roleId: null,
          roleName: null,
          permissions: new Set<Permission>(),
          ip,
          userAgent,
          impersonatorUserId,
          apiKeyId: null,
          dataScope: 'all',
          sellingScope: 'all',
          scopeLocationIds: null,
          auditLogged: false,
        };
        return true;
      }
      throw new ForbiddenException('You are not a member of that business');
    }

    const permissions = await this.loadPermissions(membership.roleId);
    // Per-user matrix adjustments (PLAN-POS-OPERATIONS §2): role defaults
    // first, then explicit grants/revokes for this membership.
    const overrides = await this.db
      .select({
        permission: schema.membershipPermissionOverrides.permission,
        allowed: schema.membershipPermissionOverrides.allowed,
      })
      .from(schema.membershipPermissionOverrides)
      .where(eq(schema.membershipPermissionOverrides.membershipId, membership.membershipId));
    for (const o of overrides) {
      if (o.allowed) permissions.add(o.permission as Permission);
      else permissions.delete(o.permission as Permission);
    }
    // Sales-data scoping (Sales Views Phase 1): a 'store'-scoped member's
    // visible locations come from membership_location_scopes. Loaded here
    // once per request so query-layer helpers never re-fetch.
    let scopeLocationIds: string[] | null = null;
    if (membership.dataScope === 'store' || membership.sellingScope === 'approved') {
      const scopeRows = await this.db
        .select({ locationId: schema.membershipLocationScopes.locationId })
        .from(schema.membershipLocationScopes)
        .where(eq(schema.membershipLocationScopes.membershipId, membership.membershipId));
      scopeLocationIds = scopeRows.map((r) => r.locationId);
    }
    req.tenant = {
      userId: user.id,
      isSuperAdmin: user.isSuperAdmin,
      businessId,
      membershipId: membership.membershipId,
      roleId: membership.roleId,
      roleName: membership.roleName,
      permissions,
      ip,
      userAgent,
      impersonatorUserId,
      apiKeyId: null,
      dataScope: membership.dataScope,
      sellingScope: membership.sellingScope,
      scopeLocationIds,
      auditLogged: false,
    };
    return true;
  }

  /** Up to two of the user's active businesses — enough to tell none / one / several. */
  private async activeBusinessIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ businessId: schema.memberships.businessId })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.status, 'active')))
      .limit(2);
    return rows.map((r) => r.businessId);
  }

  private async loadMembership(
    userId: string,
    businessId: string,
  ): Promise<{
    membershipId: string;
    roleId: string;
    roleName: string;
    dataScope: 'all' | 'store';
    sellingScope: 'all' | 'approved';
  } | null> {
    const rows = await this.db
      .select({
        membershipId: schema.memberships.id,
        roleId: schema.memberships.roleId,
        roleName: schema.roles.name,
        status: schema.memberships.status,
        dataScope: schema.memberships.dataScope,
        sellingScope: schema.memberships.sellingScope,
      })
      .from(schema.memberships)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
      .where(
        and(eq(schema.memberships.userId, userId), eq(schema.memberships.businessId, businessId)),
      )
      .limit(1);
    const found = rows[0];
    if (!found) return null;
    if (found.status !== 'active') return null;
    return {
      membershipId: found.membershipId,
      roleId: found.roleId,
      roleName: found.roleName,
      dataScope: found.dataScope === 'store' ? 'store' : 'all',
      sellingScope: found.sellingScope === 'approved' ? 'approved' : 'all',
    };
  }

  private async loadPermissions(roleId: string): Promise<Set<Permission>> {
    const rows = await this.db
      .select({ permission: schema.rolePermissions.permission })
      .from(schema.rolePermissions)
      .where(eq(schema.rolePermissions.roleId, roleId));
    return new Set(rows.map((r) => r.permission as Permission));
  }
}

function pickActiveBusinessId(req: Request): string | null {
  const fromHeader = req.headers[ACTIVE_BUSINESS_HEADER];
  if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader;
  const fromCookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[
    ACTIVE_BUSINESS_COOKIE
  ];
  if (typeof fromCookie === 'string' && fromCookie.length > 0) return fromCookie;
  // Express doesn't parse cookies by default; fall back to manual parse.
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return null;
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    if (k === ACTIVE_BUSINESS_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return null;
}

function emptyTenantContext(
  user: CurrentUserPayload,
  ip: string | null,
  userAgent: string | null,
  impersonatorUserId: string | null,
): RequestTenantContext {
  return {
    userId: user.id,
    isSuperAdmin: user.isSuperAdmin,
    businessId: null,
    membershipId: null,
    roleId: null,
    roleName: null,
    permissions: new Set<Permission>(),
    ip,
    userAgent,
    impersonatorUserId,
    apiKeyId: null,
    dataScope: 'all',
    sellingScope: 'all',
    scopeLocationIds: null,
    auditLogged: false,
  };
}

function readIp(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

function readUserAgent(req: Request): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua : null;
}
