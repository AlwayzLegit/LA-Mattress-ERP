CREATE TABLE "staff_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"location_id" uuid,
	"date" date NOT NULL,
	"start_minutes" integer,
	"end_minutes" integer,
	"published_at" timestamp with time zone,
	"updated_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_shifts_times_together" CHECK (("staff_shifts"."start_minutes" IS NULL) = ("staff_shifts"."end_minutes" IS NULL)),
	CONSTRAINT "staff_shifts_end_after_start" CHECK ("staff_shifts"."start_minutes" IS NULL OR ("staff_shifts"."start_minutes" >= 0 AND "staff_shifts"."end_minutes" > "staff_shifts"."start_minutes" AND "staff_shifts"."end_minutes" <= 1440))
);
--> statement-breakpoint
CREATE TABLE "time_punches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"location_id" uuid,
	"type" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_punches_type_check" CHECK ("time_punches"."type" in ('clock_in', 'break_start', 'break_end', 'clock_out'))
);
--> statement-breakpoint
ALTER TABLE "staff_shifts" ADD CONSTRAINT "staff_shifts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_shifts" ADD CONSTRAINT "staff_shifts_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_shifts" ADD CONSTRAINT "staff_shifts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_shifts" ADD CONSTRAINT "staff_shifts_updated_by_membership_id_memberships_id_fk" FOREIGN KEY ("updated_by_membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_punches" ADD CONSTRAINT "time_punches_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_punches" ADD CONSTRAINT "time_punches_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_punches" ADD CONSTRAINT "time_punches_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_shifts_business_date_idx" ON "staff_shifts" USING btree ("business_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_shifts_member_day_uniq" ON "staff_shifts" USING btree ("membership_id","date");--> statement-breakpoint
CREATE INDEX "time_punches_business_idx" ON "time_punches" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "time_punches_member_at_idx" ON "time_punches" USING btree ("business_id","membership_id","at");