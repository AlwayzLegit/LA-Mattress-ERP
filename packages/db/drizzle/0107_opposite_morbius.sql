CREATE TABLE "chat_help_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"body" text NOT NULL,
	"kind" text DEFAULT 'message' NOT NULL,
	"mention" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_help_message_body" CHECK (length(btrim("chat_help_messages"."body")) between 1 and 4000),
	CONSTRAINT "chat_help_message_kind" CHECK ("chat_help_messages"."kind" in ('message','suggestion'))
);
--> statement-breakpoint
ALTER TABLE "chat_help_requests" ADD COLUMN "last_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_help_requests" ADD COLUMN "requester_read_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_help_requests" ADD COLUMN "helper_read_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_help_requests" ADD COLUMN "requester_typing_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_help_requests" ADD COLUMN "helper_typing_until" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_help_tenant_key" ON "chat_help_requests" USING btree ("business_id","id");--> statement-breakpoint
ALTER TABLE "chat_help_messages" ADD CONSTRAINT "chat_help_messages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_help_messages" ADD CONSTRAINT "chat_help_messages_business_id_request_id_chat_help_requests_business_id_id_fk" FOREIGN KEY ("business_id","request_id") REFERENCES "public"."chat_help_requests"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_help_message_sequence" ON "chat_help_messages" USING btree ("business_id","request_id","sequence");--> statement-breakpoint
