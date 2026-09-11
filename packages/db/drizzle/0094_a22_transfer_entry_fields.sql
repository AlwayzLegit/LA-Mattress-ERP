ALTER TABLE "stock_transfers" ADD COLUMN "reason_code_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD COLUMN "route" text;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD COLUMN "ship_direct" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD COLUMN "fulfillment_instructions" text;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_reason_code_id_reason_codes_id_fk" FOREIGN KEY ("reason_code_id") REFERENCES "public"."reason_codes"("id") ON DELETE set null ON UPDATE no action;