CREATE TABLE "chat_help_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"helper_id" uuid NOT NULL,
	"question" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_help_state" CHECK ("chat_help_requests"."status" in ('requested','accepted','finished','cancelled')),
	CONSTRAINT "chat_help_people" CHECK ("chat_help_requests"."requester_id" <> "chat_help_requests"."helper_id")
);
--> statement-breakpoint
ALTER TABLE "chat_help_requests" ADD CONSTRAINT "chat_help_requests_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_help_requests" ADD CONSTRAINT "chat_help_requests_business_id_conversation_id_chat_conversations_business_id_id_fk" FOREIGN KEY ("business_id","conversation_id") REFERENCES "public"."chat_conversations"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_help_recipient" ON "chat_help_requests" USING btree ("business_id","helper_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_help_active" ON "chat_help_requests" USING btree ("business_id","conversation_id","helper_id") WHERE "chat_help_requests"."status" in ('requested','accepted');