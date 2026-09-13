ALTER TABLE chat_push_deliveries DROP CONSTRAINT chat_push_target;
--> statement-breakpoint
ALTER TABLE chat_push_deliveries ADD CONSTRAINT chat_push_target CHECK (
(kind in ('visitor','handoff') and conversation_id is not null and help_request_id is null and team_room_id is null)
or (kind in ('help_request','help_message') and conversation_id is null and help_request_id is not null and team_room_id is null)
or (kind = 'team_message' and conversation_id is null and help_request_id is null and team_room_id is not null));
--> statement-breakpoint
DROP INDEX chat_push_deliveries_event;
--> statement-breakpoint
CREATE UNIQUE INDEX chat_push_deliveries_event ON chat_push_deliveries (subscription_id, kind, conversation_id, sequence);
