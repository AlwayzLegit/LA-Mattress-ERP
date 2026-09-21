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
  Query,
} from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant, CurrentUser } from '../auth/current-user.decorator';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import {
  buildPage,
  clampLimit as clampPageLimit,
  decodeCursor,
  timestampCursorOrder,
  timestampCursorWhere,
  type PageResponse,
} from '../common/pagination';
import { isUniqueViolation } from '../common/db-errors';
import { DRIZZLE } from '../database/database.module';
import { RequirePermission, TenantScoped } from '../tenancy/decorators';
import type { RequestTenantContext } from '../tenancy/request-context';
import { GiftCardsService } from './gift-cards.service';

interface GiftCardRow {
  id: string;
  code: string;
  initialBalanceCents: number;
  currentBalanceCents: number;
  status: string;
  expiresAt: Date | null;
  issuedForCustomerId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface GiftCardTransactionRow {
  id: string;
  kind: string;
  amountCents: number;
  balanceAfterCents: number;
  saleId: string | null;
  refundId: string | null;
  actorUserId: string | null;
  notes: string | null;
  createdAt: Date;
}

interface IssueBody {
  initialBalanceCents?: number;
  expiresAt?: string | null;
  issuedForCustomerId?: string | null;
  notes?: string | null;
}

interface AdjustBody {
  /** Signed delta. Positive credits, negative debits. */
  amountCents?: number;
  notes?: string | null;
}

const SELECT_COLS = {
  id: schema.giftCards.id,
  code: schema.giftCards.code,
  initialBalanceCents: schema.giftCards.initialBalanceCents,
  currentBalanceCents: schema.giftCards.currentBalanceCents,
  status: schema.giftCards.status,
  expiresAt: schema.giftCards.expiresAt,
  issuedForCustomerId: schema.giftCards.issuedForCustomerId,
  notes: schema.giftCards.notes,
  createdAt: schema.giftCards.createdAt,
  updatedAt: schema.giftCards.updatedAt,
} as const;

@TenantScoped()
@Controller('v1/gift-cards')
export class GiftCardsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(GiftCardsService) private readonly service: GiftCardsService,
  ) {}

  @Get()
  @RequirePermission('gift_cards.view')
  async list(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Query('limit') limitStr?: string,
    @Query('cursor') cursorStr?: string,
  ): Promise<PageResponse<GiftCardRow>> {
    const limit = clampPageLimit(limitStr);
    const cursor = decodeCursor(cursorStr);
    const where = cursor
      ? timestampCursorWhere(schema.giftCards.createdAt, schema.giftCards.id, cursor)
      : undefined;
    const rows = await this.db
      .select(SELECT_COLS)
      .from(schema.giftCards)
      .where(where)
      .orderBy(...timestampCursorOrder(schema.giftCards.createdAt, schema.giftCards.id))
      .limit(limit + 1);
    return buildPage(rows, limit, (r) => r.createdAt);
  }

  /**
   * Cashier-facing lookup. Used by the POS to resolve a typed/scanned
   * code into a card so the cashier can apply it as a tender. Returns
   * just the spendable shape — no audit trail, no internal ids.
   */
  @Get('lookup')
  @RequirePermission('gift_cards.view')
  async lookup(
    @CurrentTenant() tenant: RequestTenantContext,
    @Query('code') code?: string,
  ): Promise<{
    id: string;
    code: string;
    currentBalanceCents: number;
    status: string;
    expiresAt: Date | null;
  }> {
    if (!code || code.trim().length === 0) {
      throw new BadRequestException('code is required');
    }
    const card = await this.service.findByCode(this.db, tenant.businessId!, code);
    if (!card) throw new NotFoundException('Gift card not found');
    return {
      id: card.id,
      code: card.code,
      currentBalanceCents: card.currentBalanceCents,
      status: card.status,
      expiresAt: card.expiresAt,
    };
  }

  @Post()
  @RequirePermission('gift_cards.issue')
  async issue(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload | undefined,
    @Body() body: IssueBody,
  ): Promise<GiftCardRow & { code: string }> {
    const initial = body.initialBalanceCents;
    if (typeof initial !== 'number' || !Number.isInteger(initial) || initial <= 0) {
      throw new BadRequestException('initialBalanceCents must be a positive integer');
    }
    if (initial > 100_000_000) {
      throw new BadRequestException('initialBalanceCents must be ≤ 100,000,000 (one million USD)');
    }
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw new BadRequestException('expiresAt must be ISO-8601');
    }

    // Retry loop for the (extraordinarily unlikely) code collision.
    // 30^16 keyspace makes this almost ceremonial, but the unique
    // constraint is real so we handle it cleanly.
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = this.service.generateCode();
      try {
        const [card] = await this.db
          .insert(schema.giftCards)
          .values({
            businessId: tenant.businessId!,
            code,
            initialBalanceCents: initial,
            currentBalanceCents: initial,
            status: 'active',
            expiresAt,
            issuedForCustomerId: body.issuedForCustomerId ?? null,
            issuedByUserId: actor?.id ?? null,
            notes: body.notes ?? null,
          })
          .returning(SELECT_COLS);
        if (!card) throw new BadRequestException('failed to issue gift card');

        await this.db.insert(schema.giftCardTransactions).values({
          businessId: tenant.businessId!,
          giftCardId: card.id,
          kind: 'issue',
          amountCents: initial,
          balanceAfterCents: initial,
          actorUserId: actor?.id ?? null,
          notes: body.notes ?? null,
        });

        await this.audit.log({
          action: 'gift_card.issue',
          targetType: 'gift_card',
          targetId: card.id,
          after: { code, initialBalanceCents: initial },
        });
        return { ...card, code };
      } catch (err) {
        if (isUniqueViolation(err, 'gift_cards_business_code_uniq')) {
          continue;
        }
        throw err;
      }
    }
    throw new BadRequestException('Failed to mint a unique gift card code; please retry');
  }

  @Get(':id')
  @RequirePermission('gift_cards.view')
  async get(
    @CurrentTenant() _tenant: RequestTenantContext,
    @Param('id') id: string,
  ): Promise<GiftCardRow & { transactions: GiftCardTransactionRow[] }> {
    const [card] = await this.db
      .select(SELECT_COLS)
      .from(schema.giftCards)
      .where(eq(schema.giftCards.id, id))
      .limit(1);
    if (!card) throw new NotFoundException('Gift card not found');

    const transactions = await this.db
      .select({
        id: schema.giftCardTransactions.id,
        kind: schema.giftCardTransactions.kind,
        amountCents: schema.giftCardTransactions.amountCents,
        balanceAfterCents: schema.giftCardTransactions.balanceAfterCents,
        saleId: schema.giftCardTransactions.saleId,
        refundId: schema.giftCardTransactions.refundId,
        actorUserId: schema.giftCardTransactions.actorUserId,
        notes: schema.giftCardTransactions.notes,
        createdAt: schema.giftCardTransactions.createdAt,
      })
      .from(schema.giftCardTransactions)
      .where(eq(schema.giftCardTransactions.giftCardId, id))
      .orderBy(desc(schema.giftCardTransactions.createdAt));

    return { ...card, transactions };
  }

  @Post(':id/adjust')
  @RequirePermission('gift_cards.adjust')
  async adjust(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload | undefined,
    @Param('id') id: string,
    @Body() body: AdjustBody,
  ): Promise<GiftCardRow> {
    const delta = body.amountCents;
    if (typeof delta !== 'number' || !Number.isInteger(delta) || delta === 0) {
      throw new BadRequestException('amountCents must be a non-zero integer');
    }
    const [card] = await this.db
      .select()
      .from(schema.giftCards)
      .where(eq(schema.giftCards.id, id))
      .limit(1);
    if (!card) throw new NotFoundException('Gift card not found');
    if (card.status === 'cancelled') {
      throw new BadRequestException('Cannot adjust a cancelled gift card.');
    }
    const newBalance = card.currentBalanceCents + delta;
    if (newBalance < 0) {
      throw new BadRequestException('Adjustment would drive balance below zero.');
    }
    const nextStatus =
      newBalance === 0 ? 'redeemed' : card.status === 'redeemed' ? 'active' : card.status;

    await this.db
      .update(schema.giftCards)
      .set({
        currentBalanceCents: newBalance,
        status: nextStatus,
        updatedAt: new Date(),
      })
      .where(eq(schema.giftCards.id, id));

    await this.db.insert(schema.giftCardTransactions).values({
      businessId: tenant.businessId!,
      giftCardId: id,
      kind: 'adjust',
      amountCents: delta,
      balanceAfterCents: newBalance,
      actorUserId: actor?.id ?? null,
      notes: body.notes ?? null,
    });

    await this.audit.log({
      action: 'gift_card.adjust',
      targetType: 'gift_card',
      targetId: id,
      before: { balanceCents: card.currentBalanceCents, status: card.status },
      after: { balanceCents: newBalance, status: nextStatus, deltaCents: delta },
    });

    const [out] = await this.db
      .select(SELECT_COLS)
      .from(schema.giftCards)
      .where(eq(schema.giftCards.id, id))
      .limit(1);
    return out!;
  }

  @Delete(':id')
  @RequirePermission('gift_cards.adjust')
  async cancel(
    @CurrentTenant() tenant: RequestTenantContext,
    @CurrentUser() actor: CurrentUserPayload | undefined,
    @Param('id') id: string,
  ): Promise<{ cancelled: true }> {
    const [card] = await this.db
      .select()
      .from(schema.giftCards)
      .where(eq(schema.giftCards.id, id))
      .limit(1);
    if (!card) throw new NotFoundException('Gift card not found');
    if (card.status === 'cancelled') {
      throw new BadRequestException('Gift card is already cancelled.');
    }
    const remaining = card.currentBalanceCents;
    await this.db
      .update(schema.giftCards)
      .set({
        currentBalanceCents: 0,
        status: 'cancelled',
        updatedAt: new Date(),
      })
      .where(eq(schema.giftCards.id, id));

    if (remaining !== 0) {
      // Record the wipeout in the ledger so the invariant
      // (balance == sum(transactions)) holds.
      await this.db.insert(schema.giftCardTransactions).values({
        businessId: tenant.businessId!,
        giftCardId: id,
        kind: 'cancel',
        amountCents: -remaining,
        balanceAfterCents: 0,
        actorUserId: actor?.id ?? null,
        notes: 'cancelled',
      });
    }

    await this.audit.log({
      action: 'gift_card.cancel',
      targetType: 'gift_card',
      targetId: id,
      before: { balanceCents: remaining, status: card.status },
      after: { balanceCents: 0, status: 'cancelled' },
    });

    return { cancelled: true };
  }
}
