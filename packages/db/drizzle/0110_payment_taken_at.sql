ALTER TABLE "payments" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "taken_by_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_taken_by_membership_id_memberships_id_fk" FOREIGN KEY ("taken_by_membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_business_location_idx" ON "payments" USING btree ("business_id","location_id","created_at");--> statement-breakpoint
-- Owner 2026-10-01: a payment belongs to the store where it was taken.
-- Every row written before today was taken at its document's store (the
-- register only sold there), so backfill that; the taker is unknown.
-- backfill:start
UPDATE "payments" p
   SET "location_id" = COALESCE(
         (SELECT s.location_id FROM sales s WHERE s.id = p.sale_id),
         (SELECT o.location_id FROM orders o WHERE o.id = p.order_id),
         (SELECT so.location_id FROM service_orders so WHERE so.id = p.service_order_id)
       )
 WHERE p."location_id" IS NULL;
-- backfill:end
