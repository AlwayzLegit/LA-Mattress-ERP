-- Custom SQL migration file, put your code below! --

-- A10 (owner 2026-11-02): an open transfer holds its units at the origin
-- the way an open sales order does. Every transfer still waiting to ship
-- (status 'draft' — the API has no separate draft phase any more; a
-- transfer is live from creation) now carries its scheduled quantity in
-- inventory_levels.reserved at the from-location, and a delta-0
-- 'transfer_reserve' movement explains the hold on the ledger, exactly
-- what the create path writes from now on. Shipping releases the hold as
-- it deducts on-hand; cancelling releases it outright.
-- backfill:start
INSERT INTO inventory_levels (business_id, variant_id, location_id, on_hand, reserved)
SELECT t.business_id, tl.variant_id, t.from_location_id, 0, sum(tl.quantity_shipped)
FROM stock_transfer_lines tl
JOIN stock_transfers t ON t.id = tl.transfer_id
WHERE t.status = 'draft' AND tl.quantity_shipped > 0
GROUP BY t.business_id, tl.variant_id, t.from_location_id
ON CONFLICT (variant_id, location_id) DO UPDATE
SET reserved = inventory_levels.reserved + EXCLUDED.reserved,
    updated_at = now();
--> statement-breakpoint
INSERT INTO inventory_movements (business_id, variant_id, location_id, delta, reason, reference_type, reference_id, actor_user_id, notes)
SELECT t.business_id, tl.variant_id, t.from_location_id, 0, 'transfer_reserve', 'stock_transfer', t.id, NULL,
       'reserved ' || tl.quantity_shipped || ' (backfill: open transfers hold their units)'
FROM stock_transfer_lines tl
JOIN stock_transfers t ON t.id = tl.transfer_id
WHERE t.status = 'draft' AND tl.quantity_shipped > 0;
-- backfill:end
