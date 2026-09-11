CREATE TABLE "chat_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"client_conversation_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_conversations_status_check" CHECK ("chat_conversations"."status" in ('queued', 'open', 'waiting_customer', 'snoozed', 'resolved', 'spam')),
	CONSTRAINT "chat_conversations_sequence_check" CHECK ("chat_conversations"."last_sequence" >= 0 and "chat_conversations"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "chat_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"credential_hash" text NOT NULL,
	"allowed_origin" text NOT NULL,
	"environment" text DEFAULT 'staging' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_integrations_environment_check" CHECK ("chat_integrations"."environment" in ('staging', 'production'))
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_type" text NOT NULL,
	"sender_id" uuid NOT NULL,
	"audience" text NOT NULL,
	"body" text NOT NULL,
	"fingerprint" text NOT NULL,
	"client_message_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_sender_check" CHECK ("chat_messages"."sender_type" in ('visitor', 'staff')),
	CONSTRAINT "chat_messages_audience_check" CHECK ("chat_messages"."audience" in ('public', 'internal') and ("chat_messages"."sender_type" <> 'visitor' or "chat_messages"."audience" = 'public')),
	CONSTRAINT "chat_messages_body_check" CHECK (length(btrim("chat_messages"."body")) between 1 and 4000),
	CONSTRAINT "chat_messages_sequence_check" CHECK ("chat_messages"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "chat_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"audience" text NOT NULL,
	"sequence" integer NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_outbox_audience_check" CHECK ("chat_outbox"."audience" in ('visitor', 'staff')),
	CONSTRAINT "chat_outbox_count_check" CHECK ("chat_outbox"."sequence" > 0 and "chat_outbox"."attempts" >= 0),
	CONSTRAINT "chat_outbox_lease_check" CHECK (("chat_outbox"."lease_token" is null) = ("chat_outbox"."lease_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"credential_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Composite FK targets must be unique before the FK is created. Drizzle emits
-- these indexes after foreign keys by default; only their order is adjusted.
CREATE UNIQUE INDEX "chat_conversations_tenant_id" ON "chat_conversations" USING btree ("business_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_integrations_tenant_id" ON "chat_integrations" USING btree ("business_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_sessions_tenant_id" ON "chat_sessions" USING btree ("business_id","id");--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_business_id_session_id_chat_sessions_business_id_id_fk" FOREIGN KEY ("business_id","session_id") REFERENCES "public"."chat_sessions"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_integrations" ADD CONSTRAINT "chat_integrations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_business_id_conversation_id_chat_conversations_business_id_id_fk" FOREIGN KEY ("business_id","conversation_id") REFERENCES "public"."chat_conversations"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_outbox" ADD CONSTRAINT "chat_outbox_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_outbox" ADD CONSTRAINT "chat_outbox_business_id_conversation_id_chat_conversations_business_id_id_fk" FOREIGN KEY ("business_id","conversation_id") REFERENCES "public"."chat_conversations"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_business_id_integration_id_chat_integrations_business_id_id_fk" FOREIGN KEY ("business_id","integration_id") REFERENCES "public"."chat_integrations"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversations_create_key" ON "chat_conversations" USING btree ("business_id","session_id","client_conversation_id");--> statement-breakpoint
CREATE INDEX "chat_conversations_queue_idx" ON "chat_conversations" USING btree ("business_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_sequence_uniq" ON "chat_messages" USING btree ("business_id","conversation_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_client_key" ON "chat_messages" USING btree ("business_id","conversation_id","sender_type","sender_id","client_message_id");--> statement-breakpoint
CREATE INDEX "chat_outbox_due_idx" ON "chat_outbox" USING btree ("business_id","completed_at","failed_at","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_outbox_event_key" ON "chat_outbox" USING btree ("business_id","conversation_id","sequence","audience");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_sessions_credential_uniq" ON "chat_sessions" USING btree ("credential_hash");--> statement-breakpoint
CREATE INDEX "chat_sessions_integration_idx" ON "chat_sessions" USING btree ("business_id","integration_id");
