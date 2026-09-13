CREATE TABLE "chat_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"available" boolean DEFAULT false NOT NULL,
	"capacity" integer DEFAULT 5 NOT NULL,
	"heartbeat_until" timestamp with time zone,
	"last_assigned_at" timestamp with time zone,
	CONSTRAINT "chat_agents_capacity_check" CHECK ("chat_agents"."capacity" between 1 and 20)
);
--> statement-breakpoint
CREATE TABLE "chat_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"client_conversation_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"assigned_membership_id" uuid,
	"location_id" uuid,
	"context_json" jsonb,
	"customer_id" uuid,
	"customer_verified_at" timestamp with time zone,
	"first_response_at" timestamp with time zone,
	"awaiting_since" timestamp with time zone,
	"assigned_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"rating" integer,
	"followup_name" text,
	"followup_method" text,
	"followup_contact" text,
	"followup_requested_at" timestamp with time zone,
	"followup_completed_at" timestamp with time zone,
	"visitor_read_sequence" integer DEFAULT 0 NOT NULL,
	"staff_read_sequence" integer DEFAULT 0 NOT NULL,
	"visitor_typing_until" timestamp with time zone,
	"staff_typing_until" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_conversations_status_check" CHECK ("chat_conversations"."status" in ('queued', 'open', 'waiting_customer', 'snoozed', 'resolved', 'spam')),
	CONSTRAINT "chat_conversations_sequence_check" CHECK ("chat_conversations"."last_sequence" >= 0 and "chat_conversations"."version" > 0)
);
--> statement-breakpoint
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
CREATE TABLE "chat_help_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"helper_id" uuid NOT NULL,
	"question" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	"requester_read_sequence" integer DEFAULT 0 NOT NULL,
	"helper_read_sequence" integer DEFAULT 0 NOT NULL,
	"requester_typing_until" timestamp with time zone,
	"helper_typing_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_help_state" CHECK ("chat_help_requests"."status" in ('requested','accepted','finished','cancelled')),
	CONSTRAINT "chat_help_people" CHECK ("chat_help_requests"."requester_id" <> "chat_help_requests"."helper_id")
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
CREATE TABLE "chat_push_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"conversation_id" uuid,
	"help_request_id" uuid,
	"team_room_id" uuid,
	"kind" text DEFAULT 'visitor' NOT NULL,
	"sequence" integer NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	CONSTRAINT "chat_push_target" CHECK (("chat_push_deliveries"."kind" = 'visitor' and "chat_push_deliveries"."conversation_id" is not null and "chat_push_deliveries"."help_request_id" is null and "chat_push_deliveries"."team_room_id" is null) or ("chat_push_deliveries"."kind" in ('help_request','help_message') and "chat_push_deliveries"."conversation_id" is null and "chat_push_deliveries"."help_request_id" is not null and "chat_push_deliveries"."team_room_id" is null) or ("chat_push_deliveries"."kind" = 'team_message' and "chat_push_deliveries"."conversation_id" is null and "chat_push_deliveries"."help_request_id" is null and "chat_push_deliveries"."team_room_id" is not null))
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
CREATE TABLE "chat_settings" (
	"business_id" uuid PRIMARY KEY NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_team_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"read_sequence" integer DEFAULT 0 NOT NULL,
	"typing_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat_team_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"body" text NOT NULL,
	"sequence" integer NOT NULL,
	"reply_to_id" uuid,
	"mention_id" uuid,
	"question" boolean DEFAULT false NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_id" uuid,
	"saved" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_team_message_body" CHECK (length(btrim("chat_team_messages"."body")) between 1 and 4000),
	CONSTRAINT "chat_team_message_state" CHECK ("chat_team_messages"."status" in ('open','claimed','resolved') and (not "chat_team_messages"."urgent" or "chat_team_messages"."question"))
);
--> statement-breakpoint
CREATE TABLE "chat_team_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"location_id" uuid,
	"member_a" uuid,
	"member_b" uuid,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_team_room_kind" CHECK (("chat_team_rooms"."kind" = 'helpdesk' and "chat_team_rooms"."location_id" is null and "chat_team_rooms"."member_a" is null and "chat_team_rooms"."member_b" is null) or ("chat_team_rooms"."kind" = 'store' and "chat_team_rooms"."location_id" is not null and "chat_team_rooms"."member_a" is null and "chat_team_rooms"."member_b" is null) or ("chat_team_rooms"."kind" = 'direct' and "chat_team_rooms"."location_id" is null and "chat_team_rooms"."member_a" is not null and "chat_team_rooms"."member_b" is not null and "chat_team_rooms"."member_a" < "chat_team_rooms"."member_b"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_agents_member" ON "chat_agents" USING btree ("business_id","membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversations_tenant_id" ON "chat_conversations" USING btree ("business_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversations_create_key" ON "chat_conversations" USING btree ("business_id","session_id","client_conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_help_message_sequence" ON "chat_help_messages" USING btree ("business_id","request_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_help_tenant_key" ON "chat_help_requests" USING btree ("business_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_help_active" ON "chat_help_requests" USING btree ("business_id","conversation_id","helper_id") WHERE "chat_help_requests"."status" in ('requested','accepted');--> statement-breakpoint
CREATE UNIQUE INDEX "chat_integrations_tenant_id" ON "chat_integrations" USING btree ("business_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_sequence_uniq" ON "chat_messages" USING btree ("business_id","conversation_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_client_key" ON "chat_messages" USING btree ("business_id","conversation_id","sender_type","sender_id","client_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_outbox_event_key" ON "chat_outbox" USING btree ("business_id","conversation_id","sequence","audience");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_push_deliveries_event" ON "chat_push_deliveries" USING btree ("subscription_id","conversation_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_push_help_event" ON "chat_push_deliveries" USING btree ("subscription_id","help_request_id","kind","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_push_team_event" ON "chat_push_deliveries" USING btree ("subscription_id","team_room_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_push_subscriptions_tenant_id" ON "chat_push_subscriptions" USING btree ("business_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_push_subscriptions_endpoint" ON "chat_push_subscriptions" USING btree ("business_id","endpoint");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_sessions_tenant_id" ON "chat_sessions" USING btree ("business_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_sessions_credential_uniq" ON "chat_sessions" USING btree ("credential_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_team_activity_member" ON "chat_team_activity" USING btree ("business_id","room_id","membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_team_message_sequence" ON "chat_team_messages" USING btree ("business_id","room_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_team_room_tenant" ON "chat_team_rooms" USING btree ("business_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_team_room_key" ON "chat_team_rooms" USING btree ("business_id","key");--> statement-breakpoint
ALTER TABLE "chat_agents" ADD CONSTRAINT "chat_agents_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_business_id_session_id_chat_sessions_business_id_id_fk" FOREIGN KEY ("business_id","session_id") REFERENCES "public"."chat_sessions"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_help_messages" ADD CONSTRAINT "chat_help_messages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_help_messages" ADD CONSTRAINT "chat_help_messages_business_id_request_id_chat_help_requests_business_id_id_fk" FOREIGN KEY ("business_id","request_id") REFERENCES "public"."chat_help_requests"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_help_requests" ADD CONSTRAINT "chat_help_requests_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_help_requests" ADD CONSTRAINT "chat_help_requests_business_id_conversation_id_chat_conversations_business_id_id_fk" FOREIGN KEY ("business_id","conversation_id") REFERENCES "public"."chat_conversations"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_integrations" ADD CONSTRAINT "chat_integrations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_business_id_conversation_id_chat_conversations_business_id_id_fk" FOREIGN KEY ("business_id","conversation_id") REFERENCES "public"."chat_conversations"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_outbox" ADD CONSTRAINT "chat_outbox_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_outbox" ADD CONSTRAINT "chat_outbox_business_id_conversation_id_chat_conversations_business_id_id_fk" FOREIGN KEY ("business_id","conversation_id") REFERENCES "public"."chat_conversations"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_push_deliveries" ADD CONSTRAINT "chat_push_deliveries_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_push_deliveries" ADD CONSTRAINT "chat_push_deliveries_business_id_help_request_id_chat_help_requests_business_id_id_fk" FOREIGN KEY ("business_id","help_request_id") REFERENCES "public"."chat_help_requests"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_push_deliveries" ADD CONSTRAINT "chat_push_deliveries_business_id_team_room_id_chat_team_rooms_business_id_id_fk" FOREIGN KEY ("business_id","team_room_id") REFERENCES "public"."chat_team_rooms"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_push_deliveries" ADD CONSTRAINT "chat_push_deliveries_business_id_subscription_id_chat_push_subscriptions_business_id_id_fk" FOREIGN KEY ("business_id","subscription_id") REFERENCES "public"."chat_push_subscriptions"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_push_deliveries" ADD CONSTRAINT "chat_push_deliveries_business_id_conversation_id_chat_conversations_business_id_id_fk" FOREIGN KEY ("business_id","conversation_id") REFERENCES "public"."chat_conversations"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_push_subscriptions" ADD CONSTRAINT "chat_push_subscriptions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_business_id_integration_id_chat_integrations_business_id_id_fk" FOREIGN KEY ("business_id","integration_id") REFERENCES "public"."chat_integrations"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_settings" ADD CONSTRAINT "chat_settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_team_activity" ADD CONSTRAINT "chat_team_activity_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_team_activity" ADD CONSTRAINT "chat_team_activity_business_id_room_id_chat_team_rooms_business_id_id_fk" FOREIGN KEY ("business_id","room_id") REFERENCES "public"."chat_team_rooms"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_team_messages" ADD CONSTRAINT "chat_team_messages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_team_messages" ADD CONSTRAINT "chat_team_messages_business_id_room_id_chat_team_rooms_business_id_id_fk" FOREIGN KEY ("business_id","room_id") REFERENCES "public"."chat_team_rooms"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_team_rooms" ADD CONSTRAINT "chat_team_rooms_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_conversations_queue_idx" ON "chat_conversations" USING btree ("business_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "chat_help_recipient" ON "chat_help_requests" USING btree ("business_id","helper_id","status");--> statement-breakpoint
CREATE INDEX "chat_outbox_due_idx" ON "chat_outbox" USING btree ("business_id","completed_at","failed_at","available_at");--> statement-breakpoint
CREATE INDEX "chat_push_deliveries_due" ON "chat_push_deliveries" USING btree ("business_id","available_at");--> statement-breakpoint
CREATE INDEX "chat_sessions_integration_idx" ON "chat_sessions" USING btree ("business_id","integration_id");