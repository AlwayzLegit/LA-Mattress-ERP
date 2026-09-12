CREATE TABLE "competition_ranks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"month" text NOT NULL,
	"scope" text NOT NULL,
	"race" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competition_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"month" text NOT NULL,
	"scope" text NOT NULL,
	"race" text NOT NULL,
	"winner_id" uuid,
	"winner_name" text,
	"winner_store" text,
	"value" integer,
	"story" text,
	"short" text,
	"prize_cents" integer DEFAULT 0 NOT NULL,
	"ranking_json" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sales_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"salesperson_membership_id" uuid NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"phone" text NOT NULL,
	"phone_digits" text NOT NULL,
	"wanted_size" text,
	"wanted_category" text,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"converted_order_id" uuid,
	"converted_at" timestamp with time zone,
	"conversion" text,
	"lost_at" timestamp with time zone,
	"follow_up_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member_notifications" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "competition_ranks" ADD CONSTRAINT "competition_ranks_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_results" ADD CONSTRAINT "competition_results_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_salesperson_membership_id_memberships_id_fk" FOREIGN KEY ("salesperson_membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_converted_order_id_orders_id_fk" FOREIGN KEY ("converted_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competition_ranks_business_idx" ON "competition_ranks" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "competition_ranks_subject_uniq" ON "competition_ranks" USING btree ("business_id","month","scope","race","subject_id");--> statement-breakpoint
CREATE INDEX "competition_results_business_idx" ON "competition_results" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "competition_results_race_uniq" ON "competition_results" USING btree ("business_id","month","scope","race");--> statement-breakpoint
CREATE INDEX "sales_leads_business_idx" ON "sales_leads" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "sales_leads_rep_idx" ON "sales_leads" USING btree ("business_id","salesperson_membership_id","status");--> statement-breakpoint
CREATE INDEX "sales_leads_phone_idx" ON "sales_leads" USING btree ("business_id","phone_digits");--> statement-breakpoint
CREATE INDEX "sales_leads_created_idx" ON "sales_leads" USING btree ("business_id","created_at");