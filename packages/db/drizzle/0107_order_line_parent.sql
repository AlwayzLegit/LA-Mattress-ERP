ALTER TABLE "order_lines" ADD COLUMN "parent_line_id" uuid;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_parent_line_id_order_lines_id_fk" FOREIGN KEY ("parent_line_id") REFERENCES "public"."order_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_lines_parent_line_id_idx" ON "order_lines" USING btree ("parent_line_id");