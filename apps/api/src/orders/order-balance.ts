/**
 * The SQL twin of `order-math.ts` balance arithmetic, so a list view, a
 * dashboard tile and the order page cannot disagree about what an order
 * still owes. Every balance read in the API goes through one of these
 * two routes:
 *
 *  - `balanceDueCentsSql(orderId, total)` for queries that select or
 *    sort by the balance in the database;
 *  - `loadReturnsSettledByOrder(db, ids)` + `balanceDueCents(total,
 *    payments, settled)` for code that already has the payment rows in
 *    hand.
 *
 * Both compute: greatest(0, total − Σ succeeded payments − Σ completed
 * returns settled on the order − credit an open exchange still owes the
 * order), where a return's settled value is its refund amount less what
 * left as store credit (see `returnsSettledCents` in order-math.ts for
 * the reasoning and the owner amendment), and the exchange term is
 * `pendingExchangeCreditCentsSql` below.
 *
 * All money is integer cents; nothing here is stored.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

/** Σ succeeded payments on the order (refund rows are negative). */
export function paidCentsSql(orderId: SQL): SQL<number> {
  return sql<number>`coalesce((select sum(p.amount_cents) from payments p
    where p.order_id = ${orderId} and p.status = 'succeeded'), 0)::int`;
}

/**
 * Store credit that left the order through one return: the credit a
 * store-credit refund issued (`order_return`), or the credit an exchange
 * minted (`exchange`, positive rows only — the redemption that applied
 * it to the replacement is money on the *other* order), less the part
 * an exchange later paid back out on this order's tenders
 * (`exchange_refund`, negative rows), which is already a refund payment
 * row and must not be subtracted twice.
 */
function creditOutCentsSql(returnId: SQL): SQL<number> {
  return sql<number>`coalesce((select sum(case
        when sce.reference_type = 'exchange_refund' then sce.delta_cents
        when sce.delta_cents > 0 then sce.delta_cents
        else 0 end)
      from store_credit_entries sce
      where (sce.reference_type = 'order_return' and sce.reference_id = ${returnId})
         or (sce.reference_type in ('exchange', 'exchange_refund')
             and sce.reference_id in (select e.id from exchanges e where e.return_id = ${returnId}))), 0)`;
}

/** Σ over completed returns of (amount − credit out), floored per return. */
export function returnsSettledCentsSql(orderId: SQL): SQL<number> {
  return sql<number>`coalesce((select sum(greatest(0, r.amount_cents - ${creditOutCentsSql(sql`r.id`)}))
    from order_returns r
    where r.order_id = ${orderId} and r.status = 'completed'), 0)::int`;
}

/**
 * Credit an open exchange has promised this (replacement) order but not
 * minted yet (owner 2026-11-12, EX-2026-000014): the returned goods ride
 * the truck back, so the return is still `authorized`, while the
 * customer pays the net at the counter the day the exchange is written —
 * what the STORIS exchange order always did. The replacement therefore
 * nets the credit from bind, not from the day the goods come back. When
 * they do, `receiveGoods` issues the credit and redeems it as a
 * store-credit tender, the return flips to `completed`, and this term
 * drops to zero as the payment row takes its place; cancel or split the
 * exchange and the term goes with it. `excludeExchangeId` is for that
 * settlement itself, which needs the balance *before* its own credit.
 */
export function pendingExchangeCreditCentsSql(
  orderId: SQL,
  excludeExchangeId?: string | null,
): SQL<number> {
  const exclude = excludeExchangeId ? sql` and e.id <> ${excludeExchangeId}` : sql``;
  return sql<number>`coalesce((select sum(greatest(0, r.amount_cents - e.restocking_fee_cents))
    from exchanges e
    join order_returns r on r.id = e.return_id
    where e.sale_order_id = ${orderId}
      and e.status in ('open', 'on_hold')
      and r.status = 'authorized'${exclude}), 0)::int`;
}

/** greatest(0, total − paid − returns settled − pending exchange credit). */
export function balanceDueCentsSql(orderId: SQL, totalCents: SQL): SQL<number> {
  return sql<number>`greatest(0, ${totalCents} - ${paidCentsSql(orderId)} - ${returnsSettledCentsSql(orderId)} - ${pendingExchangeCreditCentsSql(orderId)})::int`;
}

export interface ReturnsSettledOptions {
  /**
   * Leave out one exchange's pending credit — for the settlement that
   * mints and applies that very credit, which must see the balance the
   * credit is about to cover.
   */
  excludeExchangeId?: string | null;
  /** False = completed returns only (the "Returned" row on the order page). */
  includePendingExchangeCredit?: boolean;
}

/**
 * Everything already credited against each order, for code paths that
 * compute the balance in TypeScript: completed returns settled on it plus
 * the credit an open exchange still owes it (see
 * `pendingExchangeCreditCentsSql`). Orders with neither are simply
 * absent from the map (read as 0).
 */
export async function loadReturnsSettledByOrder(
  db: PostgresJsDatabase,
  orderIds: readonly string[],
  opts: ReturnsSettledOptions = {},
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orderIds.length === 0) return out;
  const pending =
    opts.includePendingExchangeCredit === false
      ? sql`0`
      : pendingExchangeCreditCentsSql(sql`o.id`, opts.excludeExchangeId);
  const rows = await db.execute<{ order_id: string; settled: number }>(sql`
    select o.id as order_id,
      (coalesce((select sum(greatest(0, r.amount_cents - ${creditOutCentsSql(sql`r.id`)}))
         from order_returns r
         where r.order_id = o.id and r.status = 'completed'), 0)
       + ${pending})::int as settled
    from orders o
    where o.id in ${orderIds}`);
  for (const r of rows as unknown as { order_id: string; settled: number }[]) {
    if (Number(r.settled) > 0) out.set(String(r.order_id), Number(r.settled));
  }
  return out;
}

/** Convenience for the single-order case. */
export async function loadReturnsSettled(
  db: PostgresJsDatabase,
  orderId: string,
  opts: ReturnsSettledOptions = {},
): Promise<number> {
  const m = await loadReturnsSettledByOrder(db, [orderId], opts);
  return m.get(orderId) ?? 0;
}

/** The pending exchange credit alone, for the order page and the invoice. */
export async function loadPendingExchangeCredit(
  db: PostgresJsDatabase,
  orderId: string,
): Promise<number> {
  const rows = await db.execute<{ pending: number }>(
    sql`select ${pendingExchangeCreditCentsSql(sql`${orderId}::uuid`)} as pending`,
  );
  const row = (rows as unknown as { pending: number }[])[0];
  return Number(row?.pending ?? 0);
}
