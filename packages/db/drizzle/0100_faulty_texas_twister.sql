ALTER TABLE "chat_conversations" ADD COLUMN "assigned_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "visitor_read_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "staff_read_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "visitor_typing_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "staff_typing_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "snoozed_until" timestamp with time zone;