import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import type { AuthInstance } from '../auth/auth.config';
import { AUTH_INSTANCE } from '../auth/auth.tokens';
import {
  CurrentTenant,
  CurrentUser,
  type CurrentUserPayload,
} from '../auth/current-user.decorator';
import { DRIZZLE, ROOT_DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';

/**
 * A22 slice 7 (STORIS Recover STORIS Licenses → Settings → Active
 * sessions): every sign-in held by a member of this business — who,
 * from where, on what, last seen — and the button that signs one out
 * so a stuck terminal or a departed employee's laptop is off the system
 * now. Sessions are platform rows; membership in this business is the
 * tenant boundary.
 */

export interface ActiveSessionRow {
  id: string;
  userId: string;
  membershipId: string;
  name: string | null;
  email: string;
  roleName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  current: boolean;
}

@TenantScoped()
@Controller('v1/business/sessions')
export class SessionsAdminController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    // Sessions carry an owner-only RLS policy (a member sees their own);
    // the admin listing reads through the root handle and scopes itself
    // to this business's memberships instead.
    @Inject(ROOT_DRIZZLE) private readonly rootDb: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AUTH_INSTANCE) private readonly auth: AuthInstance,
  ) {}

  @Get()
  @RequirePermission('sessions.manage')
  async list(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ActiveSessionRow[]> {
    const rows = await this.rootDb
      .select({
        id: schema.sessions.id,
        token: schema.sessions.token,
        userId: schema.sessions.userId,
        membershipId: schema.memberships.id,
        name: schema.users.name,
        email: schema.users.email,
        roleName: schema.roles.name,
        ipAddress: schema.sessions.ipAddress,
        userAgent: schema.sessions.userAgent,
        createdAt: schema.sessions.createdAt,
        lastSeenAt: schema.sessions.updatedAt,
        expiresAt: schema.sessions.expiresAt,
      })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .innerJoin(
        schema.memberships,
        and(
          eq(schema.memberships.userId, schema.sessions.userId),
          eq(schema.memberships.businessId, tenant.businessId!),
          eq(schema.memberships.status, 'active'),
        ),
      )
      .leftJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
      .where(gt(schema.sessions.expiresAt, new Date()))
      .orderBy(desc(schema.sessions.updatedAt))
      .limit(500);
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      membershipId: r.membershipId,
      name: r.name ?? null,
      email: r.email,
      roleName: r.roleName ?? null,
      ipAddress: r.ipAddress ?? null,
      userAgent: r.userAgent ?? null,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      expiresAt: r.expiresAt,
      current: r.token === user.sessionToken,
    }));
  }

  /** Sign one session out — only a session held by a member of this business. */
  @Delete(':id')
  @RequirePermission('sessions.manage')
  async revoke(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
  ): Promise<{ revoked: true }> {
    const [session] = await this.rootDb
      .select({
        id: schema.sessions.id,
        userId: schema.sessions.userId,
        token: schema.sessions.token,
      })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, id))
      .limit(1);
    if (!session) throw new NotFoundException('Session not found');
    const members = await this.db
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.businessId, tenant.businessId!),
          eq(schema.memberships.userId, session.userId),
          inArray(schema.memberships.status, ['active', 'invited', 'suspended']),
        ),
      )
      .limit(1);
    if (members.length === 0) {
      throw new ForbiddenException('That session belongs to no member of this business');
    }
    // better-auth serves sessions from Redis when it has one: revoke
    // through its adapter so the cache and the per-user session list go
    // too, then make sure the database row is gone.
    const ctx = await this.auth.$context;
    await ctx.internalAdapter.deleteSession(session.token);
    await this.rootDb.delete(schema.sessions).where(eq(schema.sessions.id, id));
    await this.audit.log({
      action: 'session.revoke',
      targetType: 'user',
      targetId: session.userId,
      metadata: { sessionId: id, own: session.token === user.sessionToken },
    });
    return { revoked: true };
  }
}
