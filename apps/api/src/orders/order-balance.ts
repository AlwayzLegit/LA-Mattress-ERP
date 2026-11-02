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
 * returns settled on the order), where a return's settled value is its
 * refund amount less what left as store credit (see `returnsSettledCents`
 * in order-math.ts for the reasoning and the owner amendment).
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

/** greatest(0, total − paid − returns settled). */
export function balanceDueCentsSql(orderId: SQL, totalCents: SQL): SQL<number> {
  return sql<number>`greatest(0, ${totalCents} - ${paidCentsSql(orderId)} - ${returnsSettledCentsSql(orderId)})::int`;
}

/**
 * Settled-return value per order for code paths that compute the
 * balance in TypeScript. Orders with no completed return are simply
 * absent from the map (read as 0).
 */
export async function loadReturnsSettledByOrder(
  db: PostgresJsDatabase,
  orderIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orderIds.length === 0) return out;
  const rows = await db.execute<{ order_id: string; settled: number }>(sql`
    select r.order_id, sum(greatest(0, r.amount_cents - ${creditOutCentsSql(sql`r.id`)}))::int as settled
    from order_returns r
    where r.order_id in ${orderIds} and r.status = 'completed'
    group by r.order_id`);
  for (const r of rows as unknown as { order_id: string; settled: number }[]) {
    out.set(String(r.order_id), Number(r.settled));
  }
  return out;
}

/** Convenience for the single-order case. */
export async function loadReturnsSettled(db: PostgresJsDatabase, orderId: string): Promise<number> {
  const m = await loadReturnsSettledByOrder(db, [orderId]);
  return m.get(orderId) ?? 0;
}
