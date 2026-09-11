ALTER TABLE "purchase_orders" ADD COLUMN "print_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "last_printed_at" timestamp with time zone;