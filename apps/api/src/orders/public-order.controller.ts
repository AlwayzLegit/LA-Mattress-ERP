import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { DRIZZLE } from '../database/database.module';
import { Public } from '../tenancy/decorators';
import { loadReturnsSettled } from './order-balance';
import { balanceDueCents, paidCents } from './order-math';

const TOKEN_RE = /^[0-9a-f]{48}$/;

export interface PublicOrderView {
  businessName: string;
  accentColor: string | null;
  number: string;
  status: string;
  customerFirstName: string | null;
  fulfillmentType: string;
  requestedDate: string | null;
  scheduledDate: string | null;
  lines: { description: string; quantity: number }[];
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  currencyCode: string;
}

/**
 * Customer-facing order status, addressed by the order's share token —
 * no session, no tenant context. Possession of the 48-hex-char token IS
 * the authorization, so the response is a deliberately narrow,
 * read-only projection: no address, no phone, no internal notes, no
 * staff names, first name only for the greeting.
 *
 * Not @TenantScoped: the token is the lookup key across tenants, and
 * the DRIZZLE proxy falls back to the root pool outside request-scoped
 * tenancy (the same pattern as /v1/auth/me).
 */
@Public()
@Controller('v1/public')
export class PublicOrderController {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase) {}

  @Get('orders/:token')
  async track(@Param('token') token: string): Promise<PublicOrderView> {
    // Shape-check before touching the DB — scanners probing short or
    // malformed tokens shouldn't cost a query.
    if (!TOKEN_RE.test(token)) throw new NotFoundException('Order not found');

    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.publicToken, token))
      .limit(1);
    if (!order) throw new NotFoundException('Order not found');

    const [business] = await this.db
      .select({
        name: schema.businesses.name,
        brandingJson: schema.businesses.brandingJson,
        currencyCode: schema.businesses.currencyCode,
      })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, order.businessId))
      .limit(1);
    const branding = (business?.brandingJson ?? null) as {
      accentColor?: string;
      publicName?: string;
    } | null;

    const [customer] = await this.db
      .select({ firstName: schema.customers.firstName })
      .from(schema.customers)
      .where(eq(schema.customers.id, order.customerId))
      .limit(1);

    const lines = await this.db
      .select({
        description: schema.orderLines.description,
        quantity: schema.orderLines.quantity,
      })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, order.id))
      .orderBy(asc(schema.orderLines.createdAt));

    const payments = await this.db
      .select({ amountCents: schema.payments.amountCents, status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.orderId, order.id));
    const paid = paidCents(payments);
    const settled = await loadReturnsSettled(this.db, order.id);

    // The next ACTIVE delivery — cancelled/failed/completed attempts
    // must not surface a stale (possibly past) date to the customer.
    const [delivery] = await this.db
      .select({ scheduledDate: schema.deliveries.scheduledDate })
      .from(schema.deliveries)
      .where(
        and(
          eq(schema.deliveries.orderId, order.id),
          inArray(schema.deliveries.status, ['scheduled', 'loaded', 'out_for_delivery']),
        ),
      )
      .orderBy(asc(schema.deliveries.scheduledDate))
      .limit(1);

    return {
      businessName: branding?.publicName ?? business?.name ?? 'Your order',
      accentColor: branding?.accentColor ?? null,
      number: order.number,
      status: order.status,
      customerFirstName: customer?.firstName ?? null,
      fulfillmentType: order.fulfillmentType,
      requestedDate: order.requestedDate ?? null,
      scheduledDate: delivery?.scheduledDate ?? null,
      lines,
      totalCents: order.totalCents,
      paidCents: paid,
      balanceCents: balanceDueCents(order.totalCents, payments, settled),
      currencyCode: business?.currencyCode ?? 'USD',
    };
  }
}
