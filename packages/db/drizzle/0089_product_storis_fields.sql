ALTER TABLE "products" ADD COLUMN "second_description" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "purchase_status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "boxes_per_product" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "logistical_carton_qty" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "purchase_carton_qty" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "logistical_carton_transfers" boolean DEFAULT false NOT NULL;