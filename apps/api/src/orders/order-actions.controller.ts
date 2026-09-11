import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant } from '../auth/current-user.decorator';
import { PriceVarianceService, type PriceControlBody } from '../controls/price-variance.service';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { assertOrderEditable } from './order-guards';
import { OrdersService } from './orders.service';

/**
 * A20 (PLAN-POS-OPERATIONS §12.16): the STORIS "Enter a Sales Order"
 * Actions menu, server side. Everything here either reads the order from
 * a new angle (tax, cost, commission, linked documents, stock, product)
 * or applies one bounded edit (attachments, a discount across lines, a
 * line split, restoring catalog prices). Money edits go through the same
 * guards as the order page — live order, print lock, no open run — and
 * every edit writes an audit row. Nothing here stores derived money.
 */

const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const ATTACHMENTS_PER_ORDER = 25;
const ATTACHMENT_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/heic',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export interface AttachmentRow {
  id: string;
  lineId: string | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  note: string | null;
  uploadedBy: string | null;
  createdAt: string;
}

interface AttachmentBody {
  name?: string;
  mimeType?: string;
  dataBase64?: string;
  lineId?: string | null;
  note?: string | null;
}

interface MultiLineDiscountBody extends PriceControlBody {
  lineIds?: string[];
  /** 'amount' = cents off each line; 'percent' = % of each line's price. */
  mode?: 'amount' | 'percent';
  value?: number;
}

interface SplitLineBody {
  /** Units that move to the new line. */
  quantity?: number;
}

export interface TaxInfo {
  storeRateBps: number;
  subtotalCents: number;
  orderDiscountCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  untaxedLines: number;
  lines: {
    id: string;
    description: string;
    quantity: number;
    taxClassId: string | null;
    taxClassName: string | null;
    taxRateBps: number;
    /** Line price after its own discount, before the pro-rata order discount. */
    lineSubtotalCents: number;
    taxCents: number;
  }[];
}

export interface CostedLines {
  lines: {
    id: string;
    description: string;
    quantity: number;
    unitCostCents: number | null;
    costCents: number | null;
    revenueCents: number;
    marginCents: number | null;
    marginPct: number | null;
  }[];
  revenueCents: number;
  costCents: number;
  marginCents: number;
  marginPct: number | null;
  linesWithoutCost: number;
}

/**
 * Projected the way accrual works at completion (CommissionsService.
 * accrueForOrder): the basis is the order total — minus catalog cost on a
 * percent_of_margin plan — split by share, times the plan rate; the
 * projection is then spread over the merchandise lines pro rata so the
 * table reads per line. Margin-plan figures reveal cost, so they are null
 * for a caller without `products.cost.view`.
 */
export interface CommissionTable {
  salespeople: {
    membershipId: string;
    name: string;
    shareBps: number;
    plan: { id: string; name: string; basis: string; rateBps: number } | null;
    /** This salesperson's share of the basis; null when hidden. */
    basisCents: number | null;
    /** Projected commission for the whole order; null when hidden. */
    commissionCents: number | null;
  }[];
  lines: {
    id: string;
    description: string;
    quantity: number;
    merchandiseCents: number;
    /** Per salesperson, in salespeople order; null when hidden. */
    commissionCents: (number | null)[];
    /** STORIS spiffs are not modeled — always null. */
    spiffCents: null;
  }[];
  totals: { merchandiseCents: number; commissionCents: (number | null)[] };
  /** True when a margin-plan projection was withheld from this caller. */
  costHidden: boolean;
}

export interface LinkedDocuments {
  lines: {
    id: string;
    description: string;
    purchaseOrders: {
      poId: string;
      number: string;
      status: string;
      expectedAt: string | null;
      quantity: number;
      allocationStatus: string;
    }[];
    deliveries: { id: string; scheduledDate: string; status: string; quantity: number }[];
    returns: { id: string; rmaNumber: string; status: string; quantity: number }[];
  }[];
  transfers: {
    id: string;
    number: string;
    status: string;
    from: string;
    to: string;
    shippedAt: string | null;
    receivedAt: string | null;
  }[];
  exchanges: { id: string; number: string; status: string; createdAt: string }[];
}

export interface LineStock {
  variantId: string;
  sku: string | null;
  levels: {
    locationId: string;
    locationName: string;
    onHand: number;
    reserved: number;
    available: number;
  }[];
}

export interface LineProduct {
  productId: string;
  name: string;
  brand: string | null;
  category: string | null;
  description: string | null;
  secondDescription: string | null;
  sku: string | null;
  variantName: string | null;
  attributes: unknown;
  priceCents: number;
  isActive: boolean;
}

@TenantScoped()
@Controller('v1/orders/:id')
export class OrderActionsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(PriceVarianceService) private readonly priceVariance: PriceVarianceService,
  ) {}

  // ---------------------------------------------------------------- attachments

  @Get('attachments')
  @RequirePermission('orders.view')
  async listAttachments(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<AttachmentRow[]> {
    await this.loadOrder(tenant, id);
    return this.attachmentRows(id);
  }

  @Post('attachments')
  @RequirePermission('orders.update')
  async addAttachment(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: AttachmentBody,
  ): Promise<AttachmentRow[]> {
    const order = await this.loadOrder(tenant, id);
    const name = text('name', body.name, 200);
    if (!name) throw new BadRequestException('name is required');
    const mimeType = (body.mimeType ?? '').trim().toLowerCase();
    if (!ATTACHMENT_MIME.has(mimeType)) {
      throw new BadRequestException('Unsupported file type — PDF, images, text, Word or Excel');
    }
    if (typeof body.dataBase64 !== 'string' || !body.dataBase64) {
      throw new BadRequestException('dataBase64 is required');
    }
    const data = body.dataBase64.replace(/^data:[^;]+;base64,/, '');
    if (!/^[A-Za-z0-9+/=\s]+$/.test(data)) {
      throw new BadRequestException('dataBase64 is not base64');
    }
    const sizeBytes = Buffer.from(data, 'base64').byteLength;
    if (sizeBytes <= 0) throw new BadRequestException('The file is empty');
    if (sizeBytes > ATTACHMENT_MAX_BYTES) {
      throw new BadRequestException('Attachments are limited to 5 MB each');
    }
    const existing = await this.db
      .select({ id: schema.orderAttachments.id })
      .from(schema.orderAttachments)
      .where(eq(schema.orderAttachments.orderId, id));
    if (existing.length >= ATTACHMENTS_PER_ORDER) {
      throw new BadRequestException(`An order holds at most ${ATTACHMENTS_PER_ORDER} attachments`);
    }
    let lineId: string | null = null;
    if (body.lineId) {
      const line = await this.loadLine(id, body.lineId);
      lineId = line.id;
    }
    const [row] = await this.db
      .insert(schema.orderAttachments)
      .values({
        businessId: order.businessId,
        orderId: id,
        lineId,
        name,
        mimeType,
        sizeBytes,
        dataBase64: data.replace(/\s+/g, ''),
        note: text('note', body.note, 500),
        uploadedByMembershipId: tenant.membershipId ?? null,
      })
      .returning({ id: schema.orderAttachments.id });
    await this.audit.log({
      action: 'order.attachment.add',
      targetType: 'order',
      targetId: id,
      before: null,
      after: { attachmentId: row!.id, name, mimeType, sizeBytes, lineId },
    });
    return this.attachmentRows(id);
  }

  @Get('attachments/:attId')
  @RequirePermission('orders.view')
  async getAttachment(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Param('attId') attId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.loadOrder(tenant, id);
    const [att] = await this.db
      .select()
      .from(schema.orderAttachments)
      .where(and(eq(schema.orderAttachments.id, attId), eq(schema.orderAttachments.orderId, id)))
      .limit(1);
    if (!att) throw new NotFoundException('Attachment not found');
    const safeName = att.name.replace(/["\r\n]/g, '_');
    res.setHeader('Content-Type', att.mimeType);
    res.setHeader('Content-Length', String(att.sizeBytes));
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'private, max-age=0');
    res.send(Buffer.from(att.dataBase64, 'base64'));
  }

  @Delete('attachments/:attId')
  @RequirePermission('orders.update')
  async deleteAttachment(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Param('attId') attId: string,
  ): Promise<AttachmentRow[]> {
    await this.loadOrder(tenant, id);
    const [att] = await this.db
      .delete(schema.orderAttachments)
      .where(and(eq(schema.orderAttachments.id, attId), eq(schema.orderAttachments.orderId, id)))
      .returning({
        id: schema.orderAttachments.id,
        name: schema.orderAttachments.name,
        sizeBytes: schema.orderAttachments.sizeBytes,
      });
    if (!att) throw new NotFoundException('Attachment not found');
    await this.audit.log({
      action: 'order.attachment.remove',
      targetType: 'order',
      targetId: id,
      before: { attachmentId: att.id, name: att.name, sizeBytes: att.sizeBytes },
      after: null,
    });
    return this.attachmentRows(id);
  }

  // ------------------------------------------------------------- line actions

  /** STORIS "Enter a Discount on Multiple Lines" / "Group Pricing". */
  @Post('lines/discount-multiple')
  @RequirePermission('orders.update')
  async discountMultiple(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Body() body: MultiLineDiscountBody,
  ): Promise<{ updated: number }> {
    const order = await this.loadOrder(tenant, id);
    await this.assertEditable(order);
    const ids = Array.isArray(body.lineIds)
      ? body.lineIds.filter((x) => typeof x === 'string')
      : [];
    if (ids.length === 0) throw new BadRequestException('lineIds is required');
    const mode = body.mode === 'percent' ? 'percent' : body.mode === 'amount' ? 'amount' : null;
    if (!mode) throw new BadRequestException("mode must be 'amount' or 'percent'");
    const value = body.value;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new BadRequestException('value must be a non-negative number');
    }
    if (mode === 'percent' && value > 100) throw new BadRequestException('percent is 0–100');
    if (mode === 'amount' && !Number.isInteger(value)) {
      throw new BadRequestException('amount is in whole cents');
    }
    const lines = await this.db
      .select({
        line: schema.orderLines,
        listPriceCents: schema.productVariants.priceCents,
        costCents: schema.productVariants.costCents,
      })
      .from(schema.orderLines)
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId))
      .where(and(eq(schema.orderLines.orderId, id), inArray(schema.orderLines.id, ids)));
    if (lines.length !== ids.length)
      throw new NotFoundException('One of the lines is not on this order');

    const planned = lines
      .map(({ line, listPriceCents, costCents }) => {
        const gross = line.quantity * line.unitPriceCents;
        const next =
          mode === 'amount'
            ? Math.min(value, gross)
            : Math.min(gross, Math.round((gross * value) / 100));
        return { line, listPriceCents, costCents, next };
      })
      .filter((p) => p.next !== p.line.discountCents);

    // G6 / A10 price monitor: a discount taken this way is logged against
    // list price exactly like a line edit on the order page (never
    // blocked; a volunteered reason rides along).
    if (planned.length > 0 && order.status !== 'draft') {
      await this.priceVariance.enforce(
        order.businessId,
        planned
          .filter((p) => p.line.variantId && p.listPriceCents != null)
          .map((p) => ({
            quantity: p.line.quantity,
            unitPriceCents: p.line.unitPriceCents,
            lineDiscountCents: p.next,
            lineType: p.line.lineType,
            listPriceCents: p.listPriceCents!,
            costCents: p.costCents ?? null,
            description: p.line.description,
          })),
        0,
        body,
        { action: `Discount lines on ${order.number}`, entityType: 'order', entityId: id },
      );
    }

    const changes: { lineId: string; before: number; after: number }[] = [];
    for (const { line, next } of planned) {
      await this.db
        .update(schema.orderLines)
        .set({ discountCents: next })
        .where(eq(schema.orderLines.id, line.id));
      changes.push({ lineId: line.id, before: line.discountCents, after: next });
    }
    if (changes.length > 0) {
      await this.orders.recomputeTotals(this.db, id);
      await this.audit.log({
        action: 'order.lines.discount',
        targetType: 'order',
        targetId: id,
        before: { lines: changes.map((c) => ({ lineId: c.lineId, discountCents: c.before })) },
        after: {
          mode,
          value,
          lines: changes.map((c) => ({ lineId: c.lineId, discountCents: c.after })),
        },
      });
    }
    return { updated: changes.length };
  }

  /**
   * STORIS "Split Merchandise Lines": move `quantity` units of one line
   * onto a new line of the same order so they can take their own
   * fulfillment, date, room or comment. Fulfilled units stay put;
   * reservations follow the units that leave only when the original has
   * more reserved than it keeps.
   */
  @Post('lines/:lineId/split')
  @RequirePermission('orders.update')
  async splitLine(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: SplitLineBody,
  ): Promise<{ newLineId: string }> {
    const order = await this.loadOrder(tenant, id);
    await this.assertEditable(order);
    const line = await this.loadLine(id, lineId);
    const q = body.quantity;
    if (!Number.isInteger(q) || (q as number) < 1 || (q as number) >= line.quantity) {
      throw new BadRequestException(`quantity must be between 1 and ${line.quantity - 1}`);
    }
    const moving = q as number;
    const keeping = line.quantity - moving;
    if (line.qtyFulfilled > keeping) {
      throw new BadRequestException(
        `${line.qtyFulfilled} units are already fulfilled and stay on this line — split at most ${line.quantity - line.qtyFulfilled}`,
      );
    }
    // Linked rows stay whole on one line: a PO allocation or a scheduled
    // delivery written against this line would be left over-allocated
    // against the shrunken quantity. Split before ordering / booking, or
    // remove the line from the delivery first.
    const [alloc] = await this.db
      .select({ id: schema.poLineAllocations.id })
      .from(schema.poLineAllocations)
      .where(eq(schema.poLineAllocations.orderLineId, line.id))
      .limit(1);
    if (alloc) {
      throw new BadRequestException(
        'This line is allocated to a purchase order — it cannot be split while the PO carries it',
      );
    }
    const [onDelivery] = await this.db
      .select({ id: schema.deliveryLines.id })
      .from(schema.deliveryLines)
      .innerJoin(schema.deliveries, eq(schema.deliveries.id, schema.deliveryLines.deliveryId))
      .where(
        and(
          eq(schema.deliveryLines.orderLineId, line.id),
          inArray(schema.deliveries.status, ['scheduled', 'loaded', 'out_for_delivery']),
        ),
      )
      .limit(1);
    if (onDelivery) {
      throw new BadRequestException(
        'This line is on a scheduled delivery — take it off the delivery before splitting it',
      );
    }
    const keepReserved = Math.min(line.qtyReserved, keeping);
    const moveReserved = line.qtyReserved - keepReserved;
    const moveDiscount = Math.round((line.discountCents * moving) / line.quantity);
    const keepDiscount = line.discountCents - moveDiscount;

    const newLineId = await this.db.transaction(async (tx) => {
      await tx
        .update(schema.orderLines)
        .set({ quantity: keeping, qtyReserved: keepReserved, discountCents: keepDiscount })
        .where(eq(schema.orderLines.id, line.id));
      const [created] = await tx
        .insert(schema.orderLines)
        .values({
          businessId: line.businessId,
          orderId: line.orderId,
          variantId: line.variantId,
          sourceLocationId: line.sourceLocationId,
          description: line.description,
          quantity: moving,
          qtyReserved: moveReserved,
          lineType: line.lineType,
          unitPriceCents: line.unitPriceCents,
          discountCents: moveDiscount,
          taxCents: 0,
          totalCents: 0,
          taxRateBps: line.taxRateBps,
          taxClassId: line.taxClassId,
          fulfillmentMethod: line.fulfillmentMethod,
          deliveryDate: line.deliveryDate,
          comment: line.comment,
          room: line.room,
          pieces: line.pieces,
          prepCodes: line.prepCodes ?? null,
          comJson: line.comJson,
          directShipJson: line.directShipJson,
          needsInstall: line.needsInstall,
        })
        .returning({ id: schema.orderLines.id });
      return created!.id;
    });
    await this.orders.recomputeTotals(this.db, id);
    await this.audit.log({
      action: 'order.line.split',
      targetType: 'order',
      targetId: id,
      before: { lineId: line.id, quantity: line.quantity, qtyReserved: line.qtyReserved },
      after: {
        lineId: line.id,
        quantity: keeping,
        qtyReserved: keepReserved,
        newLineId,
        newQuantity: moving,
        newQtyReserved: moveReserved,
      },
    });
    return { newLineId };
  }

  /** STORIS "Remove All Price Overrides and Discounts". */
  @Post('remove-overrides')
  @RequirePermission('orders.update')
  async removeOverrides(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<{ restored: number }> {
    const order = await this.loadOrder(tenant, id);
    await this.assertEditable(order);
    const lines = await this.db
      .select({
        id: schema.orderLines.id,
        lineType: schema.orderLines.lineType,
        unitPriceCents: schema.orderLines.unitPriceCents,
        discountCents: schema.orderLines.discountCents,
        listPriceCents: schema.productVariants.priceCents,
      })
      .from(schema.orderLines)
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId))
      .where(eq(schema.orderLines.orderId, id));
    const changes: Record<string, unknown>[] = [];
    for (const l of lines) {
      const list =
        l.lineType === 'custom' || l.listPriceCents == null ? l.unitPriceCents : l.listPriceCents;
      if (list === l.unitPriceCents && l.discountCents === 0) continue;
      await this.db
        .update(schema.orderLines)
        .set({ unitPriceCents: list, discountCents: 0 })
        .where(eq(schema.orderLines.id, l.id));
      changes.push({
        lineId: l.id,
        unitPriceCents: [l.unitPriceCents, list],
        discountCents: [l.discountCents, 0],
      });
    }
    if (order.orderDiscountCents !== 0) {
      await this.db
        .update(schema.orders)
        .set({ orderDiscountCents: 0, updatedAt: new Date() })
        .where(eq(schema.orders.id, id));
      changes.push({ orderDiscountCents: [order.orderDiscountCents, 0] });
    }
    if (changes.length > 0) {
      await this.orders.recomputeTotals(this.db, id);
      await this.audit.log({
        action: 'order.remove_overrides',
        targetType: 'order',
        targetId: id,
        before: { totalCents: order.totalCents },
        after: { changes },
      });
    }
    return { restored: changes.length };
  }

  // ------------------------------------------------------------------ reads

  /** STORIS "Order Tax Information". */
  @Get('tax-info')
  @RequirePermission('orders.view')
  async taxInfo(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<TaxInfo> {
    const order = await this.loadOrder(tenant, id);
    const [loc] = await this.db
      .select({ taxRateBps: schema.locations.taxRateBps })
      .from(schema.locations)
      .where(eq(schema.locations.id, order.locationId))
      .limit(1);
    const [biz] = await this.db
      .select({ rate: schema.businesses.defaultTaxRateBps })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, order.businessId))
      .limit(1);
    const lines = await this.db
      .select({
        id: schema.orderLines.id,
        description: schema.orderLines.description,
        quantity: schema.orderLines.quantity,
        unitPriceCents: schema.orderLines.unitPriceCents,
        discountCents: schema.orderLines.discountCents,
        taxRateBps: schema.orderLines.taxRateBps,
        taxCents: schema.orderLines.taxCents,
        taxClassId: schema.orderLines.taxClassId,
        taxClassName: schema.taxClasses.name,
      })
      .from(schema.orderLines)
      .leftJoin(schema.taxClasses, eq(schema.taxClasses.id, schema.orderLines.taxClassId))
      .where(eq(schema.orderLines.orderId, id))
      .orderBy(asc(schema.orderLines.createdAt));
    return {
      storeRateBps: loc?.taxRateBps ?? biz?.rate ?? 0,
      subtotalCents: order.subtotalCents,
      orderDiscountCents: order.orderDiscountCents,
      discountCents: order.discountCents,
      taxCents: order.taxCents,
      totalCents: order.totalCents,
      untaxedLines: lines.filter((l) => l.taxRateBps === 0).length,
      lines: lines.map((l) => ({
        id: l.id,
        description: l.description,
        quantity: l.quantity,
        taxClassId: l.taxClassId,
        taxClassName: l.taxClassName,
        taxRateBps: l.taxRateBps,
        lineSubtotalCents: l.quantity * l.unitPriceCents - l.discountCents,
        taxCents: l.taxCents,
      })),
    };
  }

  /** STORIS "Costed Line Item Display" / "Sales Margin Scratchpad" input. */
  @Get('costed')
  @RequirePermission('products.cost.view')
  async costed(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<CostedLines> {
    await this.loadOrder(tenant, id);
    const lines = await this.db
      .select({
        id: schema.orderLines.id,
        description: schema.orderLines.description,
        quantity: schema.orderLines.quantity,
        unitPriceCents: schema.orderLines.unitPriceCents,
        discountCents: schema.orderLines.discountCents,
        lineType: schema.orderLines.lineType,
        unitCostCents: schema.productVariants.costCents,
      })
      .from(schema.orderLines)
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId))
      .where(eq(schema.orderLines.orderId, id))
      .orderBy(asc(schema.orderLines.createdAt));
    let revenue = 0;
    let cost = 0;
    let missing = 0;
    const out = lines.map((l) => {
      const revenueCents = l.quantity * l.unitPriceCents - l.discountCents;
      const unitCost = l.lineType === 'custom' ? 0 : l.unitCostCents;
      const costCents = unitCost == null ? null : unitCost * l.quantity;
      if (costCents == null) missing += 1;
      revenue += revenueCents;
      cost += costCents ?? 0;
      const marginCents = costCents == null ? null : revenueCents - costCents;
      return {
        id: l.id,
        description: l.description,
        quantity: l.quantity,
        unitCostCents: unitCost,
        costCents,
        revenueCents,
        marginCents,
        marginPct:
          marginCents == null || revenueCents === 0
            ? null
            : Math.round((marginCents / revenueCents) * 1000) / 10,
      };
    });
    return {
      lines: out,
      revenueCents: revenue,
      costCents: cost,
      marginCents: revenue - cost,
      marginPct: revenue === 0 ? null : Math.round(((revenue - cost) / revenue) * 1000) / 10,
      linesWithoutCost: missing,
    };
  }

  /** STORIS "Price/Spiff/Commission Table": the accrual-basis projection, per line. */
  @Get('commission-table')
  @RequirePermission('orders.view')
  async commissionTable(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<CommissionTable> {
    const order = await this.loadOrder(tenant, id);
    const canSeeCost = tenant.permissions.has('products.cost.view');
    const ids = [order.salespersonMembershipId, order.secondSalespersonMembershipId].filter(
      (x): x is string => !!x,
    );
    const people = ids.length
      ? await this.db
          .select({
            membershipId: schema.memberships.id,
            name: schema.users.name,
            email: schema.users.email,
            planId: schema.commissionPlans.id,
            planName: schema.commissionPlans.name,
            basis: schema.commissionPlans.basis,
            rateBps: schema.commissionPlans.rateBps,
          })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
          .leftJoin(
            schema.commissionPlans,
            eq(schema.commissionPlans.id, schema.memberships.commissionPlanId),
          )
          .where(inArray(schema.memberships.id, ids))
      : [];
    const ordered = ids
      .map((mid) => people.find((p) => p.membershipId === mid))
      .filter((p): p is NonNullable<typeof p> => !!p);
    // Same share rule as accrual: a split only when a second salesperson
    // and a split are both set; otherwise the primary takes it all.
    const split = ordered.length > 1 && order.splitBps != null ? order.splitBps : 10000;
    const lines = await this.db
      .select({
        id: schema.orderLines.id,
        description: schema.orderLines.description,
        quantity: schema.orderLines.quantity,
        unitPriceCents: schema.orderLines.unitPriceCents,
        discountCents: schema.orderLines.discountCents,
        lineType: schema.orderLines.lineType,
        unitCostCents: schema.productVariants.costCents,
      })
      .from(schema.orderLines)
      .leftJoin(schema.productVariants, eq(schema.productVariants.id, schema.orderLines.variantId))
      .where(eq(schema.orderLines.orderId, id))
      .orderBy(asc(schema.orderLines.createdAt));
    // CommissionsService.marginCents: total minus catalog cost of every unit.
    const catalogCost = lines.reduce((n, l) => n + l.quantity * (l.unitCostCents ?? 0), 0);
    const marginBasis = Math.max(0, order.totalCents - catalogCost);

    let costHidden = false;
    const salespeople = ordered.map((p, i) => {
      const shareBps = i === 0 ? split : 10000 - split;
      const plan = p.planId
        ? { id: p.planId, name: p.planName!, basis: p.basis!, rateBps: p.rateBps! }
        : null;
      const hidden = plan?.basis === 'percent_of_margin' && !canSeeCost;
      if (hidden) costHidden = true;
      const fullBasis = plan
        ? plan.basis === 'percent_of_margin'
          ? marginBasis
          : order.totalCents
        : 0;
      const basisCents = plan && !hidden ? Math.round((fullBasis * shareBps) / 10000) : null;
      const commissionCents =
        basisCents == null ? null : plan ? Math.round((basisCents * plan.rateBps) / 10000) : null;
      return {
        membershipId: p.membershipId,
        name: p.name ?? p.email ?? '(unknown)',
        shareBps,
        plan,
        basisCents,
        commissionCents: plan ? commissionCents : null,
      };
    });

    // Spread each salesperson's projection over the merchandise lines pro
    // rata; rounding remainder lands on the last line so the column sums.
    const merch = lines
      .filter((l) => l.lineType !== 'custom')
      .map((l) => ({ ...l, merchandiseCents: l.quantity * l.unitPriceCents - l.discountCents }));
    const merchTotal = merch.reduce((n, l) => n + l.merchandiseCents, 0);
    const perLine = salespeople.map((sp) => {
      if (sp.commissionCents == null) return merch.map(() => null as number | null);
      let allocated = 0;
      return merch.map((l, i) => {
        if (i === merch.length - 1) return sp.commissionCents! - allocated;
        const c =
          merchTotal > 0 ? Math.round((sp.commissionCents! * l.merchandiseCents) / merchTotal) : 0;
        allocated += c;
        return c;
      });
    });
    return {
      salespeople,
      lines: merch.map((l, i) => ({
        id: l.id,
        description: l.description,
        quantity: l.quantity,
        merchandiseCents: l.merchandiseCents,
        commissionCents: salespeople.map((_, s) => perLine[s]![i] ?? null),
        spiffCents: null as null,
      })),
      totals: {
        merchandiseCents: merchTotal,
        commissionCents: salespeople.map((sp) => (sp.plan ? sp.commissionCents : null)),
      },
      costHidden,
    };
  }

  /** STORIS "Line Item Linked Document Display" + "View Linked Transfers". */
  @Get('linked')
  @RequirePermission('orders.view')
  async linked(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<LinkedDocuments> {
    await this.loadOrder(tenant, id);
    const lines = await this.db
      .select({ id: schema.orderLines.id, description: schema.orderLines.description })
      .from(schema.orderLines)
      .where(eq(schema.orderLines.orderId, id))
      .orderBy(asc(schema.orderLines.createdAt));
    const lineIds = lines.map((l) => l.id);
    const [pos, dels, rets, xfers, exch] = lineIds.length
      ? await Promise.all([
          this.db
            .select({
              orderLineId: schema.poLineAllocations.orderLineId,
              quantity: schema.poLineAllocations.quantity,
              allocationStatus: schema.poLineAllocations.status,
              poId: schema.purchaseOrders.id,
              number: schema.purchaseOrders.number,
              status: schema.purchaseOrders.status,
              expectedAt: schema.purchaseOrders.expectedAt,
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
            .where(inArray(schema.poLineAllocations.orderLineId, lineIds)),
          this.db
            .select({
              orderLineId: schema.deliveryLines.orderLineId,
              quantity: schema.deliveryLines.quantity,
              id: schema.deliveries.id,
              scheduledDate: schema.deliveries.scheduledDate,
              status: schema.deliveries.status,
            })
            .from(schema.deliveryLines)
            .innerJoin(schema.deliveries, eq(schema.deliveries.id, schema.deliveryLines.deliveryId))
            .where(inArray(schema.deliveryLines.orderLineId, lineIds)),
          this.db
            .select({
              orderLineId: schema.orderReturnLines.orderLineId,
              quantity: schema.orderReturnLines.quantity,
              id: schema.orderReturns.id,
              rmaNumber: schema.orderReturns.rmaNumber,
              status: schema.orderReturns.status,
            })
            .from(schema.orderReturnLines)
            .innerJoin(
              schema.orderReturns,
              eq(schema.orderReturns.id, schema.orderReturnLines.returnId),
            )
            .where(inArray(schema.orderReturnLines.orderLineId, lineIds)),
          this.transfersFor(id),
          this.db
            .select({
              id: schema.orders.id,
              number: schema.orders.number,
              status: schema.orders.status,
              createdAt: schema.orders.createdAt,
            })
            .from(schema.orders)
            .where(eq(schema.orders.originalOrderId, id))
            .orderBy(desc(schema.orders.createdAt)),
        ])
      : [[], [], [], await this.transfersFor(id), []];
    return {
      lines: lines.map((l) => ({
        id: l.id,
        description: l.description,
        purchaseOrders: pos
          .filter((p) => p.orderLineId === l.id)
          .map((p) => ({
            poId: p.poId,
            number: p.number,
            status: p.status,
            expectedAt: p.expectedAt ? p.expectedAt.toISOString() : null,
            quantity: p.quantity,
            allocationStatus: p.allocationStatus,
          })),
        deliveries: dels
          .filter((d) => d.orderLineId === l.id)
          .map((d) => ({
            id: d.id,
            scheduledDate: d.scheduledDate,
            status: d.status,
            quantity: d.quantity,
          })),
        returns: rets
          .filter((r) => r.orderLineId === l.id)
          .map((r) => ({
            id: r.id,
            rmaNumber: r.rmaNumber,
            status: r.status,
            quantity: r.quantity,
          })),
      })),
      transfers: xfers,
      exchanges: exch.map((e) => ({
        id: e.id,
        number: e.number,
        status: e.status,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  /** STORIS "Line Stock Availability": every location's position on the line's variant. */
  @Get('lines/:lineId/stock')
  @RequirePermission('orders.view')
  async lineStock(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
  ): Promise<LineStock> {
    await this.loadOrder(tenant, id);
    const line = await this.loadLine(id, lineId);
    if (!line.variantId) throw new BadRequestException('This line has no stock item');
    const [variant] = await this.db
      .select({ sku: schema.productVariants.sku })
      .from(schema.productVariants)
      .where(eq(schema.productVariants.id, line.variantId))
      .limit(1);
    const levels = await this.db
      .select({
        locationId: schema.inventoryLevels.locationId,
        locationName: schema.locations.name,
        onHand: schema.inventoryLevels.onHand,
        reserved: schema.inventoryLevels.reserved,
      })
      .from(schema.inventoryLevels)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.inventoryLevels.locationId))
      .where(eq(schema.inventoryLevels.variantId, line.variantId))
      .orderBy(asc(schema.locations.name));
    return {
      variantId: line.variantId,
      sku: variant?.sku ?? null,
      levels: levels.map((lv) => ({
        locationId: lv.locationId,
        locationName: lv.locationName,
        onHand: lv.onHand,
        reserved: lv.reserved,
        available: lv.onHand - lv.reserved,
      })),
    };
  }

  /** STORIS "Product Benefit Inquiry": the catalog card behind a line. */
  @Get('lines/:lineId/product')
  @RequirePermission('orders.view')
  async lineProduct(
    @CurrentTenant() tenant: RequestTenantContext,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
  ): Promise<LineProduct> {
    await this.loadOrder(tenant, id);
    const line = await this.loadLine(id, lineId);
    if (!line.variantId) throw new BadRequestException('This line has no catalog item');
    const [row] = await this.db
      .select({
        productId: schema.products.id,
        name: schema.products.name,
        description: schema.products.description,
        secondDescription: schema.products.secondDescription,
        isActive: schema.products.isActive,
        brand: schema.brands.name,
        category: schema.categories.name,
        sku: schema.productVariants.sku,
        variantName: schema.productVariants.name,
        attributes: schema.productVariants.attributesJson,
        priceCents: schema.productVariants.priceCents,
      })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.brands, eq(schema.brands.id, schema.products.brandId))
      .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
      .where(eq(schema.productVariants.id, line.variantId))
      .limit(1);
    if (!row) throw new NotFoundException('Product not found');
    return row;
  }

  // --------------------------------------------------------------- helpers

  private async transfersFor(orderId: string): Promise<LinkedDocuments['transfers']> {
    const fromLoc = schema.locations;
    const rows = await this.db
      .select({
        id: schema.stockTransfers.id,
        number: schema.stockTransfers.number,
        status: schema.stockTransfers.status,
        fromLocationId: schema.stockTransfers.fromLocationId,
        toLocationId: schema.stockTransfers.toLocationId,
        shippedAt: schema.stockTransfers.shippedAt,
        receivedAt: schema.stockTransfers.receivedAt,
      })
      .from(schema.stockTransfers)
      .where(eq(schema.stockTransfers.orderId, orderId))
      .orderBy(desc(schema.stockTransfers.createdAt));
    if (rows.length === 0) return [];
    const locIds = [...new Set(rows.flatMap((r) => [r.fromLocationId, r.toLocationId]))];
    const locs = await this.db
      .select({ id: fromLoc.id, name: fromLoc.name })
      .from(fromLoc)
      .where(inArray(fromLoc.id, locIds));
    const nameOf = (lid: string) => locs.find((l) => l.id === lid)?.name ?? '(unknown)';
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      from: nameOf(r.fromLocationId),
      to: nameOf(r.toLocationId),
      shippedAt: r.shippedAt ? r.shippedAt.toISOString() : null,
      receivedAt: r.receivedAt ? r.receivedAt.toISOString() : null,
    }));
  }

  private async attachmentRows(orderId: string): Promise<AttachmentRow[]> {
    const rows = await this.db
      .select({
        id: schema.orderAttachments.id,
        lineId: schema.orderAttachments.lineId,
        name: schema.orderAttachments.name,
        mimeType: schema.orderAttachments.mimeType,
        sizeBytes: schema.orderAttachments.sizeBytes,
        note: schema.orderAttachments.note,
        uploadedBy: schema.users.name,
        uploadedByEmail: schema.users.email,
        createdAt: schema.orderAttachments.createdAt,
      })
      .from(schema.orderAttachments)
      .leftJoin(
        schema.memberships,
        eq(schema.memberships.id, schema.orderAttachments.uploadedByMembershipId),
      )
      .leftJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.orderAttachments.orderId, orderId))
      .orderBy(asc(schema.orderAttachments.createdAt));
    return rows.map((r) => ({
      id: r.id,
      lineId: r.lineId,
      name: r.name,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      note: r.note,
      uploadedBy: r.uploadedBy ?? r.uploadedByEmail ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  private async loadOrder(
    tenant: RequestTenantContext,
    id: string,
  ): Promise<typeof schema.orders.$inferSelect> {
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(and(eq(schema.orders.id, id), eq(schema.orders.businessId, tenant.businessId!)))
      .limit(1);
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  private async loadLine(
    orderId: string,
    lineId: string,
  ): Promise<typeof schema.orderLines.$inferSelect> {
    const [line] = await this.db
      .select()
      .from(schema.orderLines)
      .where(and(eq(schema.orderLines.id, lineId), eq(schema.orderLines.orderId, orderId)))
      .limit(1);
    if (!line) throw new NotFoundException('Order line not found');
    return line;
  }

  /** Same three guards the order page's money edits pass: live, unlocked, off the truck. */
  private async assertEditable(order: typeof schema.orders.$inferSelect): Promise<void> {
    await assertOrderEditable(this.db, order);
  }
}

function text(field: string, v: unknown, max: number): string | null {
  if (v == null) return null;
  if (typeof v !== 'string') throw new BadRequestException(`${field} must be text`);
  const t = v.trim();
  if (t.length > max) throw new BadRequestException(`${field} must be ≤ ${max} characters`);
  return t || null;
}
