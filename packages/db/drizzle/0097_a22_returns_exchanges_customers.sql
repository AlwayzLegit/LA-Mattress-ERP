ALTER TABLE "customers" ADD COLUMN "customer_number" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "business_name" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "contact_name" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "prefix" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "middle_name" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "suffix" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "alternate_name" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "alternate_relationship" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "delivery_instructions" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "kind" text DEFAULT 'delivery' NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "return_id" uuid;--> statement-breakpoint
ALTER TABLE "order_returns" ADD COLUMN "salesperson_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "order_returns" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "order_returns" ADD COLUMN "restocking_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_returns" ADD COLUMN "pickup_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_returns" ADD COLUMN "pickup_date" date;--> statement-breakpoint
ALTER TABLE "order_returns" ADD COLUMN "pickup_delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "order_returns" ADD COLUMN "ticket_print_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "exchanges" ADD COLUMN "fulfillment" text DEFAULT 'drop_off' NOT NULL;--> statement-breakpoint
ALTER TABLE "exchanges" ADD COLUMN "refund_tender" text DEFAULT 'store_credit' NOT NULL;--> statement-breakpoint
ALTER TABLE "exchanges" ADD COLUMN "ticket_print_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_salesperson_membership_id_memberships_id_fk" FOREIGN KEY ("salesperson_membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_business_number_uniq" ON "customers" USING btree ("business_id","customer_number");--> statement-breakpoint
-- A22 slice 6: customer search now matches the customer number, the
-- business / contact name, the middle name and the alternate contact
-- (same normalization as 0033).
ALTER TABLE "customers" DROP COLUMN "search_tsv";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "search_tsv" tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      regexp_replace(
        coalesce(first_name, '') || ' ' ||
        coalesce(middle_name, '') || ' ' ||
        coalesce(last_name, '') || ' ' ||
        coalesce(business_name, '') || ' ' ||
        coalesce(contact_name, '') || ' ' ||
        coalesce(alternate_name, '') || ' ' ||
        coalesce(customer_number, '') || ' ' ||
        coalesce(email::text, '') || ' ' ||
        coalesce(phone, '') || ' ' ||
        coalesce(addresses_json::text, ''),
        '[^a-zA-Z0-9]+', ' ', 'g'
      )
    )
  ) STORED;--> statement-breakpoint
CREATE INDEX "customers_search_tsv_idx" ON "customers" USING gin ("search_tsv");--> statement-breakpoint
-- Every existing customer gets a number in creation order, per business.
UPDATE "customers" c
SET "customer_number" = 'C-' || lpad(n.rn::text, 6, '0')
FROM (
  SELECT id, row_number() OVER (PARTITION BY business_id ORDER BY created_at, id) AS rn
  FROM "customers"
) n
WHERE n.id = c.id AND c."customer_number" IS NULL;
