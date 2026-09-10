CREATE TABLE "order_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"line_id" uuid,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data_base64" text NOT NULL,
	"note" text,
	"uploaded_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_attachments_size_positive" CHECK ("order_attachments"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "work_phone" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "work_phone_ext" text;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "comment" text;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "room" text;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "pieces" integer;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "prep_codes" jsonb;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "com_json" jsonb;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "direct_ship_json" jsonb;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "needs_install" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "marketing_code_2" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "order_source" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_terminal" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "exception_notes" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "trade_designer_json" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "custom_info_json" jsonb;--> statement-breakpoint
ALTER TABLE "order_attachments" ADD CONSTRAINT "order_attachments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_attachments" ADD CONSTRAINT "order_attachments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_attachments" ADD CONSTRAINT "order_attachments_line_id_order_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."order_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_attachments" ADD CONSTRAINT "order_attachments_uploaded_by_membership_id_memberships_id_fk" FOREIGN KEY ("uploaded_by_membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_attachments_order_id_idx" ON "order_attachments" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_attachments_business_id_idx" ON "order_attachments" USING btree ("business_id");