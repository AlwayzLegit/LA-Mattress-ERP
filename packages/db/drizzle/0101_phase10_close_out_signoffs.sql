CREATE TABLE "close_out_signoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"close_date" text NOT NULL,
	"signed_by_user_id" uuid,
	"signed_by_name" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"open_exception_count" integer DEFAULT 0 NOT NULL,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "close_out_signoffs" ADD CONSTRAINT "close_out_signoffs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_out_signoffs" ADD CONSTRAINT "close_out_signoffs_signed_by_user_id_users_id_fk" FOREIGN KEY ("signed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "close_out_signoffs_business_id_idx" ON "close_out_signoffs" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "close_out_signoffs_location_date_uniq" ON "close_out_signoffs" USING btree ("location_id","close_date");