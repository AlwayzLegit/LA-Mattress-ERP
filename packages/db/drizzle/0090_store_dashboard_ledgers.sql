CREATE TABLE "cash_pickup_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_change_acks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"audit_log_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cash_pickup_receipts" ADD CONSTRAINT "cash_pickup_receipts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_pickup_receipts" ADD CONSTRAINT "cash_pickup_receipts_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_pickup_receipts" ADD CONSTRAINT "cash_pickup_receipts_received_by_membership_id_memberships_id_fk" FOREIGN KEY ("received_by_membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_change_acks" ADD CONSTRAINT "order_change_acks_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_change_acks" ADD CONSTRAINT "order_change_acks_audit_log_id_audit_logs_id_fk" FOREIGN KEY ("audit_log_id") REFERENCES "public"."audit_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_change_acks" ADD CONSTRAINT "order_change_acks_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_pickup_receipts_business_idx" ON "cash_pickup_receipts" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_pickup_receipts_payment_uniq" ON "cash_pickup_receipts" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "order_change_acks_business_idx" ON "order_change_acks" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "order_change_acks_member_idx" ON "order_change_acks" USING btree ("business_id","membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_change_acks_change_member_uniq" ON "order_change_acks" USING btree ("audit_log_id","membership_id");