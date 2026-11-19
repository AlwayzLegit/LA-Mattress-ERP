ALTER TABLE "order_lines" ADD COLUMN "as_is_item_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD COLUMN "as_is_item_id" uuid;--> statement-breakpoint
ALTER TABLE "as_is_items" ADD COLUMN "order_line_id" uuid;--> statement-breakpoint
ALTER TABLE "as_is_items" ADD COLUMN "transfer_line_id" uuid;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_as_is_item_id_as_is_items_id_fk" FOREIGN KEY ("as_is_item_id") REFERENCES "public"."as_is_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_as_is_item_id_as_is_items_id_fk" FOREIGN KEY ("as_is_item_id") REFERENCES "public"."as_is_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_lines_as_is_item_id_idx" ON "order_lines" USING btree ("as_is_item_id");--> statement-breakpoint
CREATE INDEX "as_is_items_order_line_id_idx" ON "as_is_items" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "as_is_items_transfer_line_id_idx" ON "as_is_items" USING btree ("transfer_line_id");