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
CREATE UNIQUE INDEX "chat_team_room_tenant" ON "chat_team_rooms" USING btree ("business_id","id");--> statement-breakpoint
ALTER TABLE "chat_team_activity" ADD CONSTRAINT "chat_team_activity_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_team_activity" ADD CONSTRAINT "chat_team_activity_business_id_room_id_chat_team_rooms_business_id_id_fk" FOREIGN KEY ("business_id","room_id") REFERENCES "public"."chat_team_rooms"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_team_messages" ADD CONSTRAINT "chat_team_messages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_team_messages" ADD CONSTRAINT "chat_team_messages_business_id_room_id_chat_team_rooms_business_id_id_fk" FOREIGN KEY ("business_id","room_id") REFERENCES "public"."chat_team_rooms"("business_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_team_rooms" ADD CONSTRAINT "chat_team_rooms_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_team_activity_member" ON "chat_team_activity" USING btree ("business_id","room_id","membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_team_message_sequence" ON "chat_team_messages" USING btree ("business_id","room_id","sequence");--> statement-breakpoint

CREATE UNIQUE INDEX "chat_team_room_key" ON "chat_team_rooms" USING btree ("business_id","key");