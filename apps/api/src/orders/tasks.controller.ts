import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import { schema } from '@jetnine/db';
import { taskCreateSchema, taskUpdateSchema } from '@jetnine/shared';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant } from '../auth/current-user.decorator';
import { salesScopeCond } from '../common/sales-scope';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { notifyMembers, orderTeam } from './collaboration';

function parse<S extends z.ZodTypeAny>(validator: S, input: unknown): z.output<S> {
  const result = validator.safeParse(input);
  if (!result.success)
    throw new BadRequestException(result.error.issues.map((i) => i.message).join('; '));
  return result.data;
}
function member(tenant: RequestTenantContext) {
  if (!tenant.membershipId)
    throw new ForbiddenException('Sign in as a business member to manage tasks');
  return tenant.membershipId;
}
const uuid = (id: string) => parse(z.string().uuid(), id);
const assignee = alias(schema.memberships, 'task_assignee');
const assigneeUser = alias(schema.users, 'task_assignee_user');
const t = schema.orderTasks;

@TenantScoped()
@Controller('v1')
export class TasksController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async requireOrder(tenant: RequestTenantContext, id: string) {
    const [order] = await this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        locationId: schema.orders.locationId,
      })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.id, uuid(id)),
          eq(schema.orders.businessId, tenant.businessId!),
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      );
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  @Get('orders/:id/team')
  @RequirePermission('orders.view')
  async team(@CurrentTenant() tenant: RequestTenantContext, @Param('id') id: string) {
    const order = await this.requireOrder(tenant, id);
    return orderTeam(this.db, tenant.businessId!, order.locationId);
  }

  @Get('tasks')
  @RequirePermission('orders.view')
  async list(@CurrentTenant() tenant: RequestTenantContext, @Query() raw: Record<string, string>) {
    const query = parse(
      z.object({
        queue: z.enum(['mine', 'team', 'overdue', 'blocked', 'done', 'unassigned']).default('mine'),
        orderId: z.string().uuid().optional(),
        q: z.string().trim().max(160).default(''),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      raw,
    );
    if (query.orderId) await this.requireOrder(tenant, query.orderId);
    const base = and(
      eq(t.businessId, tenant.businessId!),
      salesScopeCond(tenant, schema.orders.locationId),
      query.orderId ? eq(t.orderId, query.orderId) : undefined,
    );
    const now = new Date();
    const active = ne(t.status, 'done');
    const mine = tenant.membershipId ? eq(t.assigneeMembershipId, tenant.membershipId) : sql`false`;
    const unassigned = or(isNull(t.assigneeMembershipId), ne(assignee.status, 'active'));
    const filter = and(
      base,
      query.queue === 'done' ? eq(t.status, 'done') : active,
      query.queue === 'mine' ? mine : undefined,
      query.queue === 'overdue' ? lt(t.dueAt, now) : undefined,
      query.queue === 'blocked' ? eq(t.status, 'blocked') : undefined,
      query.queue === 'unassigned' ? unassigned : undefined,
      query.q
        ? or(ilike(t.title, `%${query.q}%`), ilike(schema.orders.number, `%${query.q}%`))
        : undefined,
    );
    const rows = await this.db
      .select({
        ...getTableColumns(t),
        orderNumber: schema.orders.number,
        customerName: sql<string>`trim(concat(${schema.customers.firstName}, ' ', ${schema.customers.lastName}))`,
        assigneeName: assigneeUser.name,
        assigneeActive: sql<boolean>`coalesce(${assignee.status} = 'active', false)`,
      })
      .from(t)
      .innerJoin(schema.orders, eq(schema.orders.id, t.orderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .leftJoin(assignee, eq(assignee.id, t.assigneeMembershipId))
      .leftJoin(assigneeUser, eq(assigneeUser.id, assignee.userId))
      .where(filter)
      .orderBy(sql`${t.dueAt} asc nulls last`, sql`(${t.priority} = 'high') desc`, asc(t.id))
      .limit(query.limit)
      .offset(query.offset);
    const [total] = await this.db
      .select({ value: count() })
      .from(t)
      .innerJoin(schema.orders, eq(schema.orders.id, t.orderId))
      .leftJoin(assignee, eq(assignee.id, t.assigneeMembershipId))
      .where(filter);
    const [counts] = await this.db
      .select({
        mine: sql<number>`count(*) filter (where ${mine})::int`,
        overdue: sql<number>`count(*) filter (where ${lt(t.dueAt, now)})::int`,
        blocked: sql<number>`count(*) filter (where ${t.status} = 'blocked')::int`,
        unassigned: sql<number>`count(*) filter (where ${unassigned})::int`,
      })
      .from(t)
      .innerJoin(schema.orders, eq(schema.orders.id, t.orderId))
      .leftJoin(assignee, eq(assignee.id, t.assigneeMembershipId))
      .where(and(base, active));
    return { data: rows, total: total!.value, counts, offset: query.offset, limit: query.limit };
  }

  @Post('orders/:id/tasks')
  @RequirePermission('orders.view')
  async create(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const creator = member(tenant);
    const order = await this.requireOrder(tenant, id);
    const input = parse(taskCreateSchema, body);
    const team = await orderTeam(this.db, tenant.businessId!, order.locationId);
    if (input.assigneeMembershipId && !team.some((m) => m.id === input.assigneeMembershipId))
      throw new BadRequestException('Choose an active member who can see this order');
    const [task] = await this.db
      .insert(t)
      .values({
        ...input,
        businessId: tenant.businessId!,
        orderId: id,
        createdByMembershipId: creator,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
      })
      .returning();
    await this.audit.log({
      action: 'order.task.create',
      targetType: 'order',
      targetId: id,
      after: {
        taskId: task!.id,
        title: task!.title,
        assigneeMembershipId: task!.assigneeMembershipId,
        dueAt: input.dueAt,
      },
    });
    await notifyMembers(this.db, {
      businessId: tenant.businessId!,
      orderId: id,
      locationId: order.locationId,
      recipients: [task!.assigneeMembershipId],
      actorMembershipId: creator,
      taskId: task!.id,
      eventKey: `task:${task!.id}:1`,
      kind: 'task_assigned',
      title: 'Task assigned to you',
      message: task!.title,
    });
    return task;
  }

  @Get('task-orders')
  @RequirePermission('orders.view')
  async findOrders(@CurrentTenant() tenant: RequestTenantContext, @Query('q') raw?: string) {
    const q = parse(z.string().trim().min(2).max(120), raw);
    return this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        customerName: sql<string>`trim(concat(${schema.customers.firstName}, ' ', ${schema.customers.lastName}))`,
      })
      .from(schema.orders)
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .where(
        and(
          eq(schema.orders.businessId, tenant.businessId!),
          salesScopeCond(tenant, schema.orders.locationId),
          or(
            ilike(schema.orders.number, `%${q}%`),
            ilike(
              sql`concat(${schema.customers.firstName}, ' ', ${schema.customers.lastName})`,
              `%${q}%`,
            ),
          ),
        ),
      )
      .orderBy(desc(schema.orders.createdAt))
      .limit(20);
  }

  @Patch('tasks/:id')
  @RequirePermission('orders.view')
  async update(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const actor = member(tenant);
    const input = parse(taskUpdateSchema, body);
    const [before] = await this.db
      .select()
      .from(t)
      .where(and(eq(t.id, uuid(id)), eq(t.businessId, tenant.businessId!)));
    if (!before) throw new NotFoundException('Task not found');
    const order = await this.requireOrder(tenant, before.orderId);
    if (input.assigneeMembershipId) {
      const team = await orderTeam(this.db, tenant.businessId!, order.locationId);
      if (!team.some((m) => m.id === input.assigneeMembershipId))
        throw new BadRequestException('Choose an active member who can see this order');
    }
    const { version, dueAt, ...fields } = input;
    if (!Object.keys(fields).length && dueAt === undefined)
      throw new BadRequestException('Choose a task change');
    if (version !== before.version)
      throw new ConflictException('This task changed. Refresh it before saving your update.');
    const fieldsChanged = Object.entries(fields).some(
      ([key, value]) => before[key as keyof typeof fields] !== value,
    );
    const deadlineChanged =
      dueAt !== undefined &&
      (dueAt ? new Date(dueAt).getTime() : null) !== (before.dueAt?.getTime() ?? null);
    // Saving an unchanged form should not send another update to the team.
    if (!fieldsChanged && !deadlineChanged) return before;
    const [task] = await this.db
      .update(t)
      .set({
        ...fields,
        ...(dueAt !== undefined ? { dueAt: dueAt ? new Date(dueAt) : null } : {}),
        ...(input.status
          ? { completedAt: input.status === 'done' ? (before.completedAt ?? new Date()) : null }
          : {}),
        version: sql`${t.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(t.id, id), eq(t.businessId, tenant.businessId!), eq(t.version, version)))
      .returning();
    if (!task)
      throw new ConflictException('This task changed. Refresh it before saving your update.');
    await this.audit.log({
      action: 'order.task.update',
      targetType: 'order',
      targetId: task.orderId,
      before: {
        taskId: id,
        title: before.title,
        description: before.description,
        priority: before.priority,
        status: before.status,
        assigneeMembershipId: before.assigneeMembershipId,
        dueAt: before.dueAt,
      },
      after: {
        taskId: id,
        title: task.title,
        description: task.description,
        priority: task.priority,
        status: task.status,
        assigneeMembershipId: task.assigneeMembershipId,
        dueAt: task.dueAt,
      },
    });
    await notifyMembers(this.db, {
      businessId: tenant.businessId!,
      orderId: task.orderId,
      locationId: order.locationId,
      recipients: [
        task.assigneeMembershipId,
        before.assigneeMembershipId,
        task.createdByMembershipId,
      ],
      actorMembershipId: actor,
      taskId: id,
      eventKey: `task:${id}:${task.version}`,
      kind: 'task_updated',
      title:
        task.status === 'done'
          ? 'Task completed'
          : task.status === 'blocked'
            ? 'Task blocked'
            : 'Task updated',
      message: task.title,
    });
    return task;
  }

  @Get('inbox')
  @RequirePermission('orders.view')
  async inbox(@CurrentTenant() tenant: RequestTenantContext) {
    const n = schema.memberNotifications;
    // A competition notice has no order (redesign Phase 11); order notices
    // stay behind the viewer's store scope.
    const scope = salesScopeCond(tenant, schema.orders.locationId);
    const filter = and(
      eq(n.businessId, tenant.businessId!),
      tenant.membershipId ? eq(n.recipientMembershipId, tenant.membershipId) : sql`false`,
      scope ? or(isNull(n.orderId), scope) : undefined,
    );
    const data = await this.db
      .select({
        id: n.id,
        kind: n.kind,
        title: n.title,
        message: n.message,
        orderId: n.orderId,
        orderNumber: schema.orders.number,
        taskId: n.taskId,
        noteId: n.noteId,
        createdAt: n.createdAt,
        readAt: n.readAt,
      })
      .from(n)
      .leftJoin(schema.orders, eq(schema.orders.id, n.orderId))
      .where(filter)
      .orderBy(sql`(${n.readAt} is null) desc`, desc(n.createdAt), desc(n.id))
      .limit(50);
    const [unread] = await this.db
      .select({ value: count() })
      .from(n)
      .leftJoin(schema.orders, eq(schema.orders.id, n.orderId))
      .where(and(filter, isNull(n.readAt)));
    return {
      data,
      unread: unread!.value,
      businessId: tenant.businessId!,
      membershipId: tenant.membershipId,
    };
  }

  @Post('inbox/read')
  @RequirePermission('orders.view')
  async read(@CurrentTenant() tenant: RequestTenantContext, @Body() body: unknown) {
    const recipient = member(tenant);
    const { ids } = parse(
      z.object({ ids: z.array(z.string().uuid()).min(1).max(50) }).strict(),
      body,
    );
    const n = schema.memberNotifications;
    const visibleOrders = this.db
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.businessId, tenant.businessId!),
          salesScopeCond(tenant, schema.orders.locationId),
        ),
      );
    const rows = await this.db
      .update(n)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(n.businessId, tenant.businessId!),
          eq(n.recipientMembershipId, recipient),
          inArray(n.id, ids),
          or(isNull(n.orderId), inArray(n.orderId, visibleOrders)),
          isNull(n.readAt),
        ),
      )
      .returning({ id: n.id });
    return { updated: rows.length };
  }
}
