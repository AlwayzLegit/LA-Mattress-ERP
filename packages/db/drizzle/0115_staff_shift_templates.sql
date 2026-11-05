CREATE TABLE "staff_shift_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"location_id" uuid,
	"dow" integer NOT NULL,
	"start_minutes" integer NOT NULL,
	"end_minutes" integer NOT NULL,
	"updated_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_shift_templates_dow_range" CHECK ("staff_shift_templates"."dow" >= 0 AND "staff_shift_templates"."dow" <= 6),
	CONSTRAINT "staff_shift_templates_end_after_start" CHECK ("staff_shift_templates"."start_minutes" >= 0 AND "staff_shift_templates"."end_minutes" > "staff_shift_templates"."start_minutes" AND "staff_shift_templates"."end_minutes" <= 1440)
);
--> statement-breakpoint
ALTER TABLE "staff_shift_templates" ADD CONSTRAINT "staff_shift_templates_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_shift_templates" ADD CONSTRAINT "staff_shift_templates_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_shift_templates" ADD CONSTRAINT "staff_shift_templates_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_shift_templates" ADD CONSTRAINT "staff_shift_templates_updated_by_membership_id_memberships_id_fk" FOREIGN KEY ("updated_by_membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_shift_templates_business_idx" ON "staff_shift_templates" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_shift_templates_member_dow_uniq" ON "staff_shift_templates" USING btree ("membership_id","dow");