import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { CurrentTenant } from '../auth/current-user.decorator';
import { isDay } from '../common/date-range';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { toCsv } from './csv';
import { textPagesToPdf } from './text-pdf';
import {
  renderTransfersByLocationPages,
  renderTransfersByLocationText,
  transferForLabel,
} from './transfers-by-location.text';

/**
 * A22 slice 2 — STORIS "Report Transfers by Location" (TE.324): every
 * transfer line grouped by the receiving store, filtered by sending and
 * receiving location, transfer date and reserve level, with the
 * manifest it rides on. Order Qty = what the line wanted (ordered, else
 * shipped), Res Qty = what is moving (shipped), BOy Qty = the held
 * remainder (ordered − shipped). JSON for the page, csv, txt and the
 * Basic PDF spool.
 */

export type ReserveLevel = 'all' | 'partial' | 'full';

export interface TransfersByLocationLine {
  lineId: string;
  sku: string | null;
  productName: string;
  vendorModel: string | null;
  brand: string | null;
  orderQty: number;
  resQty: number;
  heldQty: number;
}

export interface TransfersByLocationTransfer {
  id: string;
  number: string;
  /** YYYY-MM-DD — shipped date, else created. */
  date: string;
  status: string;
  transferType: string;
  transferFor: string;
  fromLocationId: string;
  fromLocationName: string;
  manifestNumber: string | null;
  instructions: string | null;
  notes: string | null;
  lines: TransfersByLocationLine[];
}

export interface TransfersByLocationGroup {
  locationId: string;
  locationName: string;
  transfers: TransfersByLocationTransfer[];
  totals: { transfers: number; orderQty: number; resQty: number; heldQty: number };
}

export interface TransfersByLocationReport {
  generatedAt: string;
  range: { start: string | null; end: string | null };
  filters: {
    fromLocationId: string | null;
    toLocationId: string | null;
    reserveLevel: ReserveLevel;
    includeInstructions: boolean;
  };
  groups: TransfersByLocationGroup[];
  totals: { transfers: number; lines: number; orderQty: number; resQty: number; heldQty: number };
}

const fromLoc = alias(schema.locations, 'from_loc');
const toLoc = alias(schema.locations, 'to_loc');

@TenantScoped()
@Controller('v1/reports')
export class TransfersByLocationController {
  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase) {}

  @Get('transfers-by-location')
  @RequirePermission('reports.inventory.view')
  async report(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('fromLocationId') fromLocationId?: string,
    @Query('toLocationId') toLocationId?: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('reserveLevel') reserveLevelRaw?: string,
    @Query('includeInstructions') includeInstructionsRaw?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<TransfersByLocationReport | void> {
    const businessId = tenant.businessId!;
    if (start && !isDay(start)) throw new BadRequestException('start must be YYYY-MM-DD');
    if (end && !isDay(end)) throw new BadRequestException('end must be YYYY-MM-DD');
    if (start && end && end < start) throw new BadRequestException('end must be on or after start');
    const reserveLevel: ReserveLevel =
      reserveLevelRaw === 'partial' || reserveLevelRaw === 'full' ? reserveLevelRaw : 'all';
    if (reserveLevelRaw && reserveLevelRaw !== reserveLevel) {
      throw new BadRequestException('reserveLevel must be all, partial or full');
    }
    const includeInstructions = includeInstructionsRaw === '1' || includeInstructionsRaw === 'true';
    if (format && format !== 'json') {
      if (!['csv', 'txt', 'pdf'].includes(format)) {
        throw new BadRequestException('format must be json, csv, txt or pdf');
      }
      if (!tenant.isSuperAdmin && !tenant.permissions.has('reports.export')) {
        throw new ForbiddenException('Missing permission: reports.export');
      }
    }

    const dateCol = sql<Date>`coalesce(${schema.stockTransfers.shippedAt}, ${schema.stockTransfers.createdAt})`;
    const rows = await this.db
      .select({
        transferId: schema.stockTransfers.id,
        number: schema.stockTransfers.number,
        status: schema.stockTransfers.status,
        transferType: schema.stockTransfers.transferType,
        date: sql<string>`to_char(${dateCol} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
        fromLocationId: schema.stockTransfers.fromLocationId,
        fromLocationName: fromLoc.name,
        toLocationId: schema.stockTransfers.toLocationId,
        toLocationName: toLoc.name,
        manifestNumber: schema.stockManifests.number,
        instructions: schema.stockTransfers.fulfillmentInstructions,
        notes: schema.stockTransfers.notes,
        createdAt: schema.stockTransfers.createdAt,
        lineId: schema.stockTransferLines.id,
        sku: schema.productVariants.sku,
        productName: schema.products.name,
        vendorModel: schema.productVariants.vendorSku,
        brand: schema.brands.name,
        quantityShipped: schema.stockTransferLines.quantityShipped,
        quantityOrdered: schema.stockTransferLines.quantityOrdered,
      })
      .from(schema.stockTransferLines)
      .innerJoin(
        schema.stockTransfers,
        eq(schema.stockTransfers.id, schema.stockTransferLines.transferId),
      )
      .innerJoin(
        schema.productVariants,
        eq(schema.productVariants.id, schema.stockTransferLines.variantId),
      )
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .leftJoin(schema.brands, eq(schema.brands.id, schema.products.brandId))
      .leftJoin(fromLoc, eq(fromLoc.id, schema.stockTransfers.fromLocationId))
      .leftJoin(toLoc, eq(toLoc.id, schema.stockTransfers.toLocationId))
      .leftJoin(
        schema.stockManifests,
        eq(schema.stockManifests.id, schema.stockTransfers.manifestId),
      )
      .where(
        and(
          eq(schema.stockTransfers.businessId, businessId),
          ne(schema.stockTransfers.status, 'canceled'),
          fromLocationId ? eq(schema.stockTransfers.fromLocationId, fromLocationId) : undefined,
          toLocationId ? eq(schema.stockTransfers.toLocationId, toLocationId) : undefined,
          start ? sql`${dateCol} >= ${`${start}T00:00:00.000Z`}::timestamptz` : undefined,
          end
            ? sql`${dateCol} < (${`${end}T00:00:00.000Z`}::timestamptz + interval '1 day')`
            : undefined,
        ),
      )
      .orderBy(
        asc(toLoc.name),
        asc(schema.stockTransfers.createdAt),
        asc(schema.stockTransfers.number),
        asc(schema.stockTransferLines.id),
      );

    // Fold the joined rows into store → transfer → lines.
    const groups = new Map<string, TransfersByLocationGroup>();
    const transfersById = new Map<string, TransfersByLocationTransfer>();
    for (const r of rows) {
      let g = groups.get(r.toLocationId);
      if (!g) {
        g = {
          locationId: r.toLocationId,
          locationName: r.toLocationName ?? '(deleted location)',
          transfers: [],
          totals: { transfers: 0, orderQty: 0, resQty: 0, heldQty: 0 },
        };
        groups.set(r.toLocationId, g);
      }
      let t = transfersById.get(r.transferId);
      if (!t) {
        t = {
          id: r.transferId,
          number: r.number,
          date: r.date,
          status: r.status,
          transferType: r.transferType,
          transferFor: transferForLabel(r.transferType),
          fromLocationId: r.fromLocationId,
          fromLocationName: r.fromLocationName ?? '(deleted location)',
          manifestNumber: r.manifestNumber ?? null,
          instructions: r.instructions ?? null,
          notes: r.notes ?? null,
          lines: [],
        };
        transfersById.set(r.transferId, t);
        g.transfers.push(t);
      }
      const orderQty = r.quantityOrdered ?? r.quantityShipped;
      t.lines.push({
        lineId: r.lineId,
        sku: r.sku ?? null,
        productName: r.productName,
        vendorModel: r.vendorModel ?? null,
        brand: r.brand ?? null,
        orderQty,
        resQty: r.quantityShipped,
        heldQty: Math.max(0, orderQty - r.quantityShipped),
      });
    }
    // Reserve level: partial = something is still held; full = nothing is.
    const report: TransfersByLocationReport = {
      generatedAt: new Date().toISOString(),
      range: { start: start ?? null, end: end ?? null },
      filters: {
        fromLocationId: fromLocationId ?? null,
        toLocationId: toLocationId ?? null,
        reserveLevel,
        includeInstructions,
      },
      groups: [],
      totals: { transfers: 0, lines: 0, orderQty: 0, resQty: 0, heldQty: 0 },
    };
    for (const g of groups.values()) {
      const kept = g.transfers.filter((t) => {
        const held = t.lines.some((l) => l.heldQty > 0);
        return reserveLevel === 'all' ? true : reserveLevel === 'partial' ? held : !held;
      });
      if (kept.length === 0) continue;
      g.transfers = kept;
      for (const t of kept) {
        g.totals.transfers += 1;
        for (const l of t.lines) {
          g.totals.orderQty += l.orderQty;
          g.totals.resQty += l.resQty;
          g.totals.heldQty += l.heldQty;
          report.totals.lines += 1;
        }
      }
      report.totals.transfers += g.totals.transfers;
      report.totals.orderQty += g.totals.orderQty;
      report.totals.resQty += g.totals.resQty;
      report.totals.heldQty += g.totals.heldQty;
      report.groups.push(g);
    }

    if (!format || format === 'json') return report;
    const stem = `transfers-by-location-${start ?? 'earliest'}-to-${end ?? 'latest'}`;
    if (format === 'csv') {
      const headers = [
        'receiving_location',
        'transfer_number',
        'transfer_date',
        'sending_location',
        'transfer_for',
        'status',
        'product',
        'vendor_model',
        'brand',
        'order_qty',
        'res_qty',
        'held_qty',
        'manifest_number',
        ...(includeInstructions ? ['instructions', 'notes'] : []),
      ];
      const data: (string | number | null)[][] = [];
      for (const g of report.groups) {
        for (const t of g.transfers) {
          for (const l of t.lines) {
            data.push([
              g.locationName,
              t.number,
              t.date,
              t.fromLocationName,
              t.transferFor,
              t.status,
              l.sku ?? l.productName,
              l.vendorModel,
              l.brand,
              l.orderQty,
              l.resQty,
              l.heldQty,
              t.manifestNumber,
              ...(includeInstructions ? [t.instructions, t.notes] : []),
            ]);
          }
        }
      }
      res!.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res!.setHeader('Content-Disposition', `attachment; filename="${stem}.csv"`);
      res!.send(toCsv(headers, data));
      return;
    }
    const [business] = await this.db
      .select({ name: schema.businesses.name })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    const [loc] = await this.db
      .select({ timezone: schema.locations.timezone })
      .from(schema.locations)
      .where(eq(schema.locations.businessId, businessId))
      .orderBy(asc(schema.locations.createdAt))
      .limit(1);
    const ctx = {
      businessName: business?.name ?? '',
      generatedAt: new Date(),
      timezone: loc?.timezone ?? 'UTC',
    };
    if (format === 'pdf') {
      const pdf = textPagesToPdf(renderTransfersByLocationPages(report, ctx), {
        title: 'Report Transfers by Location',
      });
      res!.setHeader('Content-Type', 'application/pdf');
      res!.setHeader('Content-Disposition', `attachment; filename="${stem}.pdf"`);
      res!.send(pdf);
      return;
    }
    res!.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res!.setHeader('Content-Disposition', `attachment; filename="${stem}.txt"`);
    res!.send(renderTransfersByLocationText(report, ctx));
  }
}
