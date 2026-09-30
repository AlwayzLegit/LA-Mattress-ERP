ALTER TABLE "cash_pickups" ADD COLUMN "owner_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cash_pickups" ADD COLUMN "owner_received_by_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "cash_pickups" ADD COLUMN "owner_received_from" text;--> statement-breakpoint
ALTER TABLE "cash_pickups" ADD CONSTRAINT "cash_pickups_owner_received_by_membership_id_memberships_id_fk" FOREIGN KEY ("owner_received_by_membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_pickups_awaiting_owner_idx" ON "cash_pickups" USING btree ("business_id","recorded_at") WHERE owner_received_at IS NULL;--> statement-breakpoint
ALTER TABLE "cash_pickups" ADD CONSTRAINT "cash_pickups_owner_received_check" CHECK ((owner_received_at IS NULL AND owner_received_from IS NULL) OR (owner_received_at IS NOT NULL AND owner_received_from IN ('operator', 'store', 'legacy')));--> statement-breakpoint
-- Owner hand-off (owner 2026-09-30). Pickups posted before the hand-off
-- existed are settled: they must not all land on the owner's dashboard
-- as "waiting for you", so they are marked `legacy` with nobody named.
-- backfill:start
UPDATE "cash_pickups"
   SET "owner_received_at" = "recorded_at",
       "owner_received_from" = 'legacy'
 WHERE "owner_received_at" IS NULL;
-- backfill:end
