CREATE TABLE "chat_push_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat_push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"environment" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_push_subscriptions_tenant_id" ON "chat_push_subscriptions" USING btree ("business_id","id");--> statement-breakpoint
ALTER TABLE "chat_push_deliveries" ADD CONSTRAINT "chat_push_deliveries_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_push_deliveries" ADD CONSTRAINT "chat_push_deliveries_business_id_subscription_id_chat_push_subscriptions_business_id_id_fk" FOREIGN KEY ("business_id","subscription_id") REFERENCES "public"."chat_push_subscriptions"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_push_deliveries" ADD CONSTRAINT "chat_push_deliveries_business_id_conversation_id_chat_conversations_business_id_id_fk" FOREIGN KEY ("business_id","conversation_id") REFERENCES "public"."chat_conversations"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_push_subscriptions" ADD CONSTRAINT "chat_push_subscriptions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_push_deliveries_event" ON "chat_push_deliveries" USING btree ("subscription_id","conversation_id","sequence");--> statement-breakpoint
CREATE INDEX "chat_push_deliveries_due" ON "chat_push_deliveries" USING btree ("business_id","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_push_subscriptions_endpoint" ON "chat_push_subscriptions" USING btree ("business_id","endpoint");