ALTER TABLE "deliveries" ADD COLUMN "contact_status" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "contacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "service_orders" ADD COLUMN "scheduled_for" date;