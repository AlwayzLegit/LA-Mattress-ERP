CREATE TABLE "chat_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"available" boolean DEFAULT false NOT NULL,
	"capacity" integer DEFAULT 5 NOT NULL,
	"heartbeat_until" timestamp with time zone,
	CONSTRAINT "chat_agents_capacity_check" CHECK ("chat_agents"."capacity" between 1 and 20)
);
--> statement-breakpoint
ALTER TABLE "chat_agents" ADD CONSTRAINT "chat_agents_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_agents_member" ON "chat_agents" USING btree ("business_id","membership_id");