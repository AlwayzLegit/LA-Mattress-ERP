ALTER TABLE "chat_conversations" ADD COLUMN "followup_name" text;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "followup_method" text;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "followup_contact" text;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "followup_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "followup_completed_at" timestamp with time zone;