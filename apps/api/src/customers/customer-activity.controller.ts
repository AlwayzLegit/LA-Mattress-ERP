import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { DRIZZLE } from '../database/database.module';
import { deriveDisplayStatus } from '../orders/orders.controller';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';

/**
 * View Customer Activity (owner 2026-09-02, modeled on STORIS "View
 * Customer Activity"): one read that feeds the eight tabs — General
 * Information (totals), Open Orders, Order Line Details, Historical
 * Purchases, Current Deposits, Historical Deposits, Open A/R Items and
 * Open Service Orders. Every money figure is derived here from the
 * documents; nothing is stored.
 */

interface YearTotals {
  sales: { cents: number; count: number };
  returns: { cents: number; count: number };
  service: { cents: number; count: number };
}

export interface CustomerActivity {
  customer: {
    id: string;
    code: string;
    name: string;
    phone: string | null;
    phone2: string | null;
    email: string | null;
    address: {
      line1: string | null;
      line2: string | null;
      city: string | null;
      region: string | null;
      postalCode: string | null;
    } | null;
    storeCreditCents: number;
    notes: string | null;
  };
  general: {
    shipFromLocation: string | null;
    totals: { thisYear: YearTotals; lastYear: YearTotals; lifetime: YearTotals };
  };
  openOrders: {
    totalOrdersCents: number;
    depositsCents: number;
    arCents: number;
    unpaidBalanceCents: number;
    rows: {
      id: string;
      number: string;
      orderType: string;
      fulfillmentType: string;
      orderDate: string;
      salespersonName: string | null;
      merchandiseCents: number;
      otherCents: number;
      totalCents: number;
      amountPaidCents: number;
      balanceCents: number;
      displayStatus: string;
    }[];
  };
  orderLines: {
    orderId: string;
    number: string;
    status: string;
    lines: {
      id: string;
      sku: string | null;
      description: string;
      qtyReserved: number;
      qtyOrdered: number;
      backorderQty: number;
      fulfillmentDate: string | null;
      qtyReceived: number;
      poNumber: string | null;
      poId: string | null;
      poDeliveryDate: string | null;
      poQuantity: number;
      fulfillmentMethod: string;
      fulfillmentStatus: string;
    }[];
  }[];
  historicalPurchases: {
    docId: string;
    docType: 'order' | 'sale' | 'return';
    number: string;
    orderType: string;
    invoiceDate: string;
    sku: string | null;
    description: string;
    quantity: number;
    priceCents: number;
  }[];
  currentDeposits: {
    orderId: string;
    number: string;
    depositCents: number;
    orderCents: number;
    orderType: string;
    orderDate: string;
    depositType: string | null;
    arCreditCents: number;
  }[];
  historicalDeposits: {
    totalLiabilityCents: number;
    rows: {
      id: string;
      orderId: string;
      number: string;
      type: string;
      date: string;
      depositCents: number;
      activityCents: number;
      reason: string;
    }[];
  };
  openArItems: {
    id: string;
    orderId: string;
    reference: string;
    transactionDate: string;
    dueDate: string | null;
    inDispute: boolean;
    transactionType: string;
    memo: string;
    amountCents: number;
  }[];
  openServiceOrders: {
    id: string;
    number: string;
    orderDate: string;
    type: string;
    coordinator: string | null;
    status: string;
    product: string;
    description: string;
    estimatedDate: string | null;
    scheduledDate: string | null;
    totalCents: number;
  }[];
}

const OPEN_ORDER_STATUSES = ['open', 'confirmed', 'partially_fulfilled', 'fulfilled'];

function emptyYear(): YearTotals {
  return {
    sales: { cents: 0, count: 0 },
    returns: { cents: 0, count: 0 },
    service: { cents: 0, count: 0 },
  };
}

function orderTypeLabel(kind: string, fulfillmentType: string): string {
  if (kind === 'layaway') return 'Layaway';
  if (kind === 'exchange') return 'Exchange';
  if (kind === 'sale') return 'Sale';
  if (
    fulfillmentType === 'pickup' ||
    fulfillmentType === 'will_call' ||
    fulfillmentType === 'take_with'
  )
    return 'Take-With Order';
  return 'Sales Order';
}

function paymentKindLabel(kind: string): string {
  if (kind === 'deposit') return 'Deposit';
  if (kind === 'installment') return 'Installment';
  if (kind === 'balance') return 'Balance payment';
  return kind.replace(/_/g, ' ');
}

function isoDate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
}

@TenantScoped()
@Controller('v1/customers')
export class CustomerActivityController {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase) {}

  @Get(':id/activity')
  @RequirePermission('customers.view')
  async activity(@Param('id') id: string): Promise<CustomerActivity> {
    const [c] = await this.db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, id))
      .limit(1);
    if (!c) throw new NotFoundException('Customer not found');

    const now = new Date();
    const thisYear = now.getUTCFullYear();
    const yearOf = (d: Date | string | null | undefined): number | null =>
      d ? (d instanceof Date ? d : new Date(d)).getUTCFullYear() : null;
    const totals = { thisYear: emptyYear(), lastYear: emptyYear(), lifetime: emptyYear() };
    const bump = (
      d: Date | string | null | undefined,
      bucket: keyof YearTotals,
      cents: number,
    ): void => {
      const y = yearOf(d);
      const add = (t: YearTotals) => {
        t[bucket].cents += cents;
        t[bucket].count += 1;
      };
      add(totals.lifetime);
      if (y === thisYear) add(totals.thisYear);
      else if (y === thisYear - 1) add(totals.lastYear);
    };

    // ---- Orders (every non-draft/quote/cancelled) with salesperson ----
    const orders = await this.db
      .select({
        id: schema.orders.id,
        number: schema.orders.number,
        status: schema.orders.status,
        orderKind: schema.orders.orderKind,
        fulfillmentType: schema.orders.fulfillmentType,
        subtotalCents: schema.orders.subtotalCents,
        discountCents: schema.orders.discountCents,
        taxCents: schema.orders.taxCents,
        totalCents: schema.orders.totalCents,
        requestedDate: schema.orders.requestedDate,
        stockLocationId: schema.orders.stockLocationId,
        locationId: schema.orders.locationId,
        completedAt: schema.orders.completedAt,
        createdAt: schema.orders.createdAt,
        salespersonName: schema.users.name,
      })
      .from(schema.orders)
      .leftJoin(
        schema.memberships,
        eq(schema.memberships.id, schema.orders.salespersonMembershipId),
      )
      .leftJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(
        and(
          eq(schema.orders.customerId, id),
          sql`${schema.orders.status} NOT IN ('draft', 'quote', 'cancelled')`,
        ),
      )
      .orderBy(desc(schema.orders.createdAt));
    const orderIds = orders.map((o) => o.id);
    const orderById = new Map(orders.map((o) => [o.id, o]));

    // Payments on those orders (deposits, balance, installments) and refunds.
    const payments = orderIds.length
      ? await this.db
          .select({
            id: schema.payments.id,
            orderId: schema.payments.orderId,
            kind: schema.payments.kind,
            method: schema.payments.method,
            amountCents: schema.payments.amountCents,
            status: schema.payments.status,
            createdAt: schema.payments.createdAt,
          })
          .from(schema.payments)
          .where(
            and(
              inArray(schema.payments.orderId, orderIds),
              eq(schema.payments.status, 'succeeded'),
            ),
          )
          .orderBy(desc(schema.payments.createdAt))
      : [];
    const paidByOrder = new Map<string, number>();
    for (const p of payments) {
      if (!p.orderId) continue;
      paidByOrder.set(p.orderId, (paidByOrder.get(p.orderId) ?? 0) + p.amountCents);
    }

    // Lines, with PO linkage for special orders.
    const lines = orderIds.length
      ? await this.db
          .select({
            id: schema.orderLines.id,
            orderId: schema.orderLines.orderId,
            sku: schema.productVariants.sku,
            description: schema.orderLines.description,
            quantity: schema.orderLines.quantity,
            qtyReserved: schema.orderLines.qtyReserved,
            qtyFulfilled: schema.orderLines.qtyFulfilled,
            qtyReturned: schema.orderLines.qtyReturned,
            lineType: schema.orderLines.lineType,
            unitPriceCents: schema.orderLines.unitPriceCents,
            totalCents: schema.orderLines.totalCents,
            fulfillmentMethod: schema.orderLines.fulfillmentMethod,
            deliveryDate: schema.orderLines.deliveryDate,
            createdAt: schema.orderLines.createdAt,
          })
          .from(schema.orderLines)
          .leftJoin(
            schema.productVariants,
            eq(schema.productVariants.id, schema.orderLines.variantId),
          )
          .where(inArray(schema.orderLines.orderId, orderIds))
          .orderBy(schema.orderLines.createdAt)
      : [];
    const lineIds = lines.map((l) => l.id);
    const allocs = lineIds.length
      ? await this.db
          .select({
            orderLineId: schema.poLineAllocations.orderLineId,
            quantity: schema.poLineAllocations.quantity,
            allocStatus: schema.poLineAllocations.status,
            poId: schema.purchaseOrders.id,
            poNumber: schema.purchaseOrders.number,
            expectedAt: schema.purchaseOrders.expectedAt,
            poOpen: sql<boolean>`${schema.purchaseOrderLines.quantityOrdered} > ${schema.purchaseOrderLines.quantityReceived}`,
          })
          .from(schema.poLineAllocations)
          .innerJoin(
            schema.purchaseOrderLines,
            eq(schema.purchaseOrderLines.id, schema.poLineAllocations.poLineId),
          )
          .innerJoin(
            schema.purchaseOrders,
            eq(schema.purchaseOrders.id, schema.purchaseOrderLines.purchaseOrderId),
          )
          .where(
            and(
              inArray(schema.poLineAllocations.orderLineId, lineIds),
              sql`${schema.poLineAllocations.status} != 'cancelled'`,
              sql`${schema.purchaseOrders.deletedAt} IS NULL`,
            ),
          )
      : [];
    const allocByLine = new Map<
      string,
      {
        poId: string;
        poNumber: string;
        expectedAt: Date | null;
        ordered: number;
        received: number;
        open: boolean;
      }
    >();
    for (const a of allocs) {
      const cur = allocByLine.get(a.orderLineId) ?? {
        poId: a.poId,
        poNumber: a.poNumber,
        expectedAt: a.expectedAt ?? null,
        ordered: 0,
        received: 0,
        open: false,
      };
      if (a.allocStatus === 'received') cur.received += a.quantity;
      else cur.ordered += a.quantity;
      cur.open = cur.open || a.poOpen;
      allocByLine.set(a.orderLineId, cur);
    }

    // Delivery state, open returns and exchange children for display status.
    const trips = orderIds.length
      ? await this.db
          .select({
            orderId: schema.deliveries.orderId,
            scheduledDate: schema.deliveries.scheduledDate,
            status: schema.deliveries.status,
          })
          .from(schema.deliveries)
          .where(
            and(
              inArray(schema.deliveries.orderId, orderIds),
              inArray(schema.deliveries.status, ['scheduled', 'loaded', 'out_for_delivery']),
            ),
          )
      : [];
    const tripByOrder = new Map<string, { date: string | null; status: string }>();
    for (const t of trips) {
      const cur = tripByOrder.get(t.orderId);
      if (!cur || t.status === 'out_for_delivery') {
        tripByOrder.set(t.orderId, { date: t.scheduledDate, status: t.status });
      }
    }
    const returns = await this.db
      .select({
        id: schema.orderReturns.id,
        orderId: schema.orderReturns.orderId,
        rmaNumber: schema.orderReturns.rmaNumber,
        status: schema.orderReturns.status,
        refundMethod: schema.orderReturns.refundMethod,
        amountCents: schema.orderReturns.amountCents,
        reason: schema.orderReturns.reason,
        authorizedAt: schema.orderReturns.authorizedAt,
        completedAt: schema.orderReturns.completedAt,
      })
      .from(schema.orderReturns)
      .where(eq(schema.orderReturns.customerId, id));
    const awaitingPickup = new Set(
      returns.filter((r) => r.status === 'authorized' && r.orderId).map((r) => r.orderId as string),
    );
    const exchangedOriginals = new Set<string>();
    const exchangeChildren = orderIds.length
      ? await this.db
          .select({ originalOrderId: schema.orders.originalOrderId })
          .from(schema.orders)
          .where(
            and(
              inArray(schema.orders.originalOrderId, orderIds),
              sql`${schema.orders.status} != 'cancelled'`,
            ),
          )
      : [];
    for (const r of exchangeChildren)
      if (r.originalOrderId) exchangedOriginals.add(r.originalOrderId);

    const linesByOrder = new Map<string, typeof lines>();
    for (const l of lines) {
      const arr = linesByOrder.get(l.orderId) ?? [];
      arr.push(l);
      linesByOrder.set(l.orderId, arr);
    }

    // ---- Open orders ----
    const openRows: CustomerActivity['openOrders']['rows'] = [];
    let totalOrdersCents = 0;
    let depositsCents = 0;
    let unpaidBalanceCents = 0;
    let arCents = 0;
    const openArItems: CustomerActivity['openArItems'] = [];
    for (const o of orders) {
      if (!OPEN_ORDER_STATUSES.includes(o.status)) continue;
      const paid = paidByOrder.get(o.id) ?? 0;
      const balance = Math.max(0, o.totalCents - paid);
      const ls = linesByOrder.get(o.id) ?? [];
      const reservedShort = ls.some(
        (l) => l.lineType === 'stock' && l.qtyReserved + l.qtyFulfilled < l.quantity,
      );
      const onPo = ls.some((l) => allocByLine.get(l.id)?.open);
      const fulfilled = ls.reduce((s, l) => s + l.qtyFulfilled, 0);
      const returned = ls.reduce((s, l) => s + l.qtyReturned, 0);
      const trip = tripByOrder.get(o.id);
      const displayStatus = deriveDisplayStatus({
        status: o.status,
        orderKind: o.orderKind,
        balance,
        tripStatus: trip?.status ?? null,
        onPo,
        reservedShort,
        awaitingPickup: awaitingPickup.has(o.id),
        fullyReturned: returned > 0 && returned >= fulfilled,
        exchanged: exchangedOriginals.has(o.id),
      });
      const merchandise = o.subtotalCents - o.discountCents;
      openRows.push({
        id: o.id,
        number: o.number,
        orderType: orderTypeLabel(o.orderKind, o.fulfillmentType),
        fulfillmentType: o.fulfillmentType,
        orderDate: isoDate(o.createdAt)!,
        salespersonName: o.salespersonName ?? null,
        merchandiseCents: merchandise,
        otherCents: o.totalCents - merchandise,
        totalCents: o.totalCents,
        amountPaidCents: paid,
        balanceCents: balance,
        displayStatus,
      });
      totalOrdersCents += o.totalCents;
      depositsCents += paid;
      unpaidBalanceCents += balance;
      // A delivered order still owing money is a receivable.
      if (displayStatus === 'Delivered' && balance > 0) {
        arCents += balance;
        openArItems.push({
          id: o.id,
          orderId: o.id,
          reference: o.number,
          transactionDate: isoDate(o.completedAt ?? o.createdAt)!,
          dueDate: isoDate(o.completedAt ?? o.createdAt),
          inDispute: false,
          transactionType: 'Invoice balance',
          memo: `${orderTypeLabel(o.orderKind, o.fulfillmentType)} delivered, balance open`,
          amountCents: balance,
        });
      }
    }

    // Unpaid layaway / plan installments are receivables too.
    const installments = orderIds.length
      ? await this.db
          .select({
            id: schema.paymentPlanInstallments.id,
            orderId: schema.paymentPlans.orderId,
            seq: schema.paymentPlanInstallments.seq,
            dueDate: schema.paymentPlanInstallments.dueDate,
            amountCents: schema.paymentPlanInstallments.amountCents,
            status: schema.paymentPlanInstallments.status,
            planType: schema.paymentPlans.type,
            planStatus: schema.paymentPlans.status,
            createdAt: schema.paymentPlanInstallments.createdAt,
          })
          .from(schema.paymentPlanInstallments)
          .innerJoin(
            schema.paymentPlans,
            eq(schema.paymentPlans.id, schema.paymentPlanInstallments.planId),
          )
          .where(
            and(
              inArray(schema.paymentPlans.orderId, orderIds),
              eq(schema.paymentPlans.status, 'active'),
              sql`${schema.paymentPlanInstallments.status} NOT IN ('paid', 'cancelled')`,
            ),
          )
          .orderBy(schema.paymentPlanInstallments.dueDate)
      : [];
    for (const i of installments) {
      const o = orderById.get(i.orderId);
      if (!o) continue;
      arCents += i.amountCents;
      openArItems.push({
        id: i.id,
        orderId: i.orderId,
        reference: `${o.number} #${i.seq}`,
        transactionDate: isoDate(i.createdAt)!,
        dueDate: i.dueDate,
        inDispute: false,
        transactionType: i.planType === 'layaway' ? 'Layaway installment' : 'Installment',
        memo: i.dueDate && i.dueDate < isoDate(now)! ? 'Past due' : 'Scheduled',
        amountCents: i.amountCents,
      });
    }
    openArItems.sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));

    // ---- Order line details (every order, newest first) ----
    const orderLines: CustomerActivity['orderLines'] = orders.map((o) => ({
      orderId: o.id,
      number: o.number,
      status: o.status,
      lines: (linesByOrder.get(o.id) ?? []).map((l) => {
        const po = allocByLine.get(l.id);
        const trip = tripByOrder.get(o.id);
        const fulfillmentStatus =
          l.qtyFulfilled >= l.quantity
            ? 'Delivered'
            : l.qtyFulfilled > 0
              ? 'Partially delivered'
              : trip
                ? 'Scheduled'
                : po?.open
                  ? 'On PO'
                  : l.qtyReserved >= l.quantity
                    ? 'Reserved'
                    : 'Pending';
        return {
          id: l.id,
          sku: l.sku ?? null,
          description: l.description,
          qtyReserved: l.qtyReserved,
          qtyOrdered: l.quantity,
          backorderQty: Math.max(0, l.quantity - l.qtyReserved - l.qtyFulfilled),
          fulfillmentDate: l.deliveryDate ?? trip?.date ?? o.requestedDate ?? null,
          qtyReceived: po?.received ?? 0,
          poNumber: po?.poNumber ?? null,
          poId: po?.poId ?? null,
          poDeliveryDate: isoDate(po?.expectedAt),
          poQuantity: po ? po.ordered + po.received : 0,
          fulfillmentMethod:
            l.fulfillmentMethod === 'take_with' ||
            l.fulfillmentMethod === 'pickup' ||
            l.fulfillmentMethod === 'will_call'
              ? 'Take-With'
              : 'Delivery',
          fulfillmentStatus,
        };
      }),
    }));

    // ---- Historical purchases: completed orders, register sales, returns ----
    const historicalPurchases: CustomerActivity['historicalPurchases'] = [];
    for (const o of orders) {
      const delivered = o.status === 'completed' || o.status === 'fulfilled';
      if (!delivered) continue;
      const date = isoDate(o.completedAt ?? o.createdAt)!;
      for (const l of linesByOrder.get(o.id) ?? []) {
        historicalPurchases.push({
          docId: o.id,
          docType: 'order',
          number: o.number,
          orderType: orderTypeLabel(o.orderKind, o.fulfillmentType),
          invoiceDate: date,
          sku: l.sku ?? null,
          description: l.description,
          quantity: l.quantity,
          priceCents: l.unitPriceCents,
        });
      }
    }
    const sales = await this.db
      .select({
        id: schema.sales.id,
        number: schema.sales.number,
        status: schema.sales.status,
        totalCents: schema.sales.totalCents,
        completedAt: schema.sales.completedAt,
        createdAt: schema.sales.createdAt,
      })
      .from(schema.sales)
      .where(
        and(
          eq(schema.sales.customerId, id),
          sql`${schema.sales.status} IN ('completed', 'partially_refunded', 'refunded')`,
        ),
      )
      .orderBy(desc(schema.sales.createdAt));
    const saleIds = sales.map((s) => s.id);
    const saleLines = saleIds.length
      ? await this.db
          .select({
            id: schema.saleLines.id,
            saleId: schema.saleLines.saleId,
            sku: schema.productVariants.sku,
            description: schema.saleLines.description,
            quantity: schema.saleLines.quantity,
            unitPriceCents: schema.saleLines.unitPriceCents,
          })
          .from(schema.saleLines)
          .leftJoin(
            schema.productVariants,
            eq(schema.productVariants.id, schema.saleLines.variantId),
          )
          .where(inArray(schema.saleLines.saleId, saleIds))
      : [];
    for (const s of sales) {
      const date = isoDate(s.completedAt ?? s.createdAt)!;
      for (const l of saleLines.filter((x) => x.saleId === s.id)) {
        historicalPurchases.push({
          docId: s.id,
          docType: 'sale',
          number: s.number,
          orderType: 'Register sale',
          invoiceDate: date,
          sku: l.sku ?? null,
          description: l.description,
          quantity: l.quantity,
          priceCents: l.unitPriceCents,
        });
      }
    }
    const returnIds = returns.map((r) => r.id);
    const returnLines = returnIds.length
      ? await this.db
          .select({
            id: schema.orderReturnLines.id,
            returnId: schema.orderReturnLines.returnId,
            sku: schema.productVariants.sku,
            description: schema.orderReturnLines.description,
            quantity: schema.orderReturnLines.quantity,
            perUnitCents: schema.orderReturnLines.perUnitCents,
          })
          .from(schema.orderReturnLines)
          .leftJoin(
            schema.productVariants,
            eq(schema.productVariants.id, schema.orderReturnLines.variantId),
          )
          .where(inArray(schema.orderReturnLines.returnId, returnIds))
      : [];
    for (const r of returns) {
      if (r.status === 'cancelled') continue;
      const o = r.orderId ? orderById.get(r.orderId) : undefined;
      const date = isoDate(r.completedAt ?? r.authorizedAt ?? now)!;
      for (const l of returnLines.filter((x) => x.returnId === r.id)) {
        historicalPurchases.push({
          docId: r.orderId ?? r.id,
          docType: 'return',
          number: r.rmaNumber ?? o?.number ?? '—',
          orderType: 'Return',
          invoiceDate: date,
          sku: l.sku ?? null,
          description: l.description ?? '—',
          quantity: -l.quantity,
          priceCents: l.perUnitCents,
        });
      }
    }
    historicalPurchases.sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate));

    // ---- Deposits ----
    const currentDeposits: CustomerActivity['currentDeposits'] = [];
    for (const o of orders) {
      if (!OPEN_ORDER_STATUSES.includes(o.status)) continue;
      const paid = paidByOrder.get(o.id) ?? 0;
      const latest = payments.find((p) => p.orderId === o.id);
      currentDeposits.push({
        orderId: o.id,
        number: o.number,
        depositCents: paid,
        orderCents: o.totalCents,
        orderType: orderTypeLabel(o.orderKind, o.fulfillmentType),
        orderDate: isoDate(o.createdAt)!,
        depositType: latest ? latest.method.replace(/_/g, ' ') : null,
        arCreditCents: Math.max(0, paid - o.totalCents),
      });
    }
    const historicalRows: CustomerActivity['historicalDeposits']['rows'] = payments
      .filter((p) => p.orderId)
      .map((p) => {
        const o = orderById.get(p.orderId as string);
        return {
          id: p.id,
          orderId: p.orderId as string,
          number: o?.number ?? '—',
          type: paymentKindLabel(p.kind),
          date: isoDate(p.createdAt)!,
          depositCents: p.amountCents,
          activityCents: p.amountCents,
          reason: `${paymentKindLabel(p.kind)} · ${p.method.replace(/_/g, ' ')}`,
        };
      });
    for (const r of returns) {
      if (r.status !== 'completed' || r.amountCents <= 0) continue;
      const o = r.orderId ? orderById.get(r.orderId) : undefined;
      historicalRows.push({
        id: r.id,
        orderId: r.orderId ?? '',
        number: o?.number ?? r.rmaNumber ?? '—',
        type: 'Refund',
        date: isoDate(r.completedAt ?? now)!,
        depositCents: 0,
        activityCents: -r.amountCents,
        reason: `Return ${r.rmaNumber ?? ''} · ${(r.refundMethod ?? 'refund').replace(/_/g, ' ')}${r.reason ? ` · ${r.reason}` : ''}`,
      });
    }
    historicalRows.sort((a, b) => b.date.localeCompare(a.date));

    // ---- Service orders ----
    const service = await this.db
      .select({
        id: schema.serviceOrders.id,
        number: schema.serviceOrders.number,
        status: schema.serviceOrders.status,
        itemDescription: schema.serviceOrders.itemDescription,
        issue: schema.serviceOrders.issue,
        warranty: schema.serviceOrders.warranty,
        totalCents: schema.serviceOrders.totalCents,
        completedAt: schema.serviceOrders.completedAt,
        createdAt: schema.serviceOrders.createdAt,
        updatedAt: schema.serviceOrders.updatedAt,
        technicianName: schema.users.name,
      })
      .from(schema.serviceOrders)
      .leftJoin(
        schema.memberships,
        eq(schema.memberships.id, schema.serviceOrders.technicianMembershipId),
      )
      .leftJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.serviceOrders.customerId, id))
      .orderBy(desc(schema.serviceOrders.createdAt));
    const openServiceOrders: CustomerActivity['openServiceOrders'] = service
      .filter((s) => s.status !== 'completed' && s.status !== 'cancelled')
      .map((s) => ({
        id: s.id,
        number: s.number,
        orderDate: isoDate(s.createdAt)!,
        type: s.warranty ? 'Warranty' : 'Service',
        coordinator: s.technicianName ?? null,
        status: s.status,
        product: s.itemDescription ?? '—',
        description: s.issue,
        estimatedDate: null,
        scheduledDate: s.status === 'ready' ? isoDate(s.updatedAt) : null,
        totalCents: s.totalCents,
      }));

    // ---- Totals (General Information) ----
    for (const o of orders) bump(o.completedAt ?? o.createdAt, 'sales', o.totalCents);
    for (const s of sales) bump(s.completedAt ?? s.createdAt, 'sales', s.totalCents);
    for (const r of returns) {
      if (r.status === 'completed' || r.status === 'received') {
        bump(r.completedAt ?? r.authorizedAt ?? now, 'returns', r.amountCents);
      }
    }
    const refunds = saleIds.length
      ? await this.db
          .select({ amountCents: schema.refunds.amountCents, createdAt: schema.refunds.createdAt })
          .from(schema.refunds)
          .where(inArray(schema.refunds.saleId, saleIds))
      : [];
    for (const r of refunds) bump(r.createdAt, 'returns', r.amountCents);
    for (const s of service) {
      if (s.status === 'cancelled') continue;
      bump(s.completedAt ?? s.createdAt, 'service', s.totalCents);
    }

    // Ship-from: the stock location of the most recent order that names
    // one, else the store the most recent order was written at.
    let shipFromLocation: string | null = null;
    const locId =
      orders.find((o) => o.stockLocationId)?.stockLocationId ?? orders[0]?.locationId ?? null;
    if (locId) {
      const [loc] = await this.db
        .select({ name: schema.locations.name })
        .from(schema.locations)
        .where(eq(schema.locations.id, locId))
        .limit(1);
      shipFromLocation = loc?.name ?? null;
    }

    const [credit] = await this.db
      .select({
        cents: sql<number>`COALESCE(SUM(${schema.storeCreditEntries.deltaCents}), 0)::int`,
      })
      .from(schema.storeCreditEntries)
      .where(eq(schema.storeCreditEntries.customerId, id));

    const addresses = Array.isArray(c.addressesJson)
      ? (c.addressesJson as {
          label?: string | null;
          line1?: string | null;
          line2?: string | null;
          city?: string | null;
          region?: string | null;
          postalCode?: string | null;
        }[])
      : [];
    const addr = addresses.find((a) => a?.label === 'delivery') ?? addresses[0] ?? null;

    return {
      customer: {
        id: c.id,
        code: c.id.slice(0, 8).toUpperCase(),
        name: [c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name)',
        phone: c.phone,
        phone2: c.phone2,
        email: c.email,
        address: addr
          ? {
              line1: addr.line1 ?? null,
              line2: addr.line2 ?? null,
              city: addr.city ?? null,
              region: addr.region ?? null,
              postalCode: addr.postalCode ?? null,
            }
          : null,
        storeCreditCents: credit?.cents ?? 0,
        notes: c.notes,
      },
      general: { shipFromLocation, totals },
      openOrders: {
        totalOrdersCents,
        depositsCents,
        arCents,
        unpaidBalanceCents,
        rows: openRows,
      },
      orderLines,
      historicalPurchases,
      currentDeposits,
      historicalDeposits: { totalLiabilityCents: depositsCents, rows: historicalRows },
      openArItems,
      openServiceOrders,
    };
  }
}
