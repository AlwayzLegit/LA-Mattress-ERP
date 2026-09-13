CREATE TABLE "cash_pickup_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"pickup_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_pickups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"number" text NOT NULL,
	"recorded_by_membership_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"counted_cents" integer NOT NULL,
	"expected_cents" integer NOT NULL,
	"variance_cents" integer NOT NULL,
	"slip" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cash_pickup_items" ADD CONSTRAINT "cash_pickup_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_pickup_items" ADD CONSTRAINT "cash_pickup_items_pickup_id_cash_pickups_id_fk" FOREIGN KEY ("pickup_id") REFERENCES "public"."cash_pickups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_pickup_items" ADD CONSTRAINT "cash_pickup_items_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_pickups" ADD CONSTRAINT "cash_pickups_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_pickups" ADD CONSTRAINT "cash_pickups_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_pickups" ADD CONSTRAINT "cash_pickups_recorded_by_membership_id_memberships_id_fk" FOREIGN KEY ("recorded_by_membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_pickup_items_business_idx" ON "cash_pickup_items" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "cash_pickup_items_pickup_idx" ON "cash_pickup_items" USING btree ("pickup_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_pickup_items_payment_uniq" ON "cash_pickup_items" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "cash_pickups_business_idx" ON "cash_pickups" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "cash_pickups_store_idx" ON "cash_pickups" USING btree ("business_id","location_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_pickups_number_uniq" ON "cash_pickups" USING btree ("business_id","number");