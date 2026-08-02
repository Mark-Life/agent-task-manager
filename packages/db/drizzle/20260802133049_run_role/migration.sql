ALTER TABLE "agent_session" RENAME COLUMN "comment_watermark_at" TO "unread_watermark_at";--> statement-breakpoint
ALTER TABLE "agent_session" RENAME COLUMN "comment_watermark_id" TO "unread_watermark_id";--> statement-breakpoint
ALTER TABLE "agent_session" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_message" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "role" text DEFAULT 'worker' NOT NULL;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "run_command" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "run_event" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_message" DROP COLUMN "provider_session_id";--> statement-breakpoint
ALTER TABLE "run" DROP COLUMN "agent_home_path";--> statement-breakpoint
ALTER TABLE "chat_thread" DROP COLUMN "provider_session_id";--> statement-breakpoint
ALTER TABLE "agent_session" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_message" ALTER COLUMN "telegram_chat_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_thread" ALTER COLUMN "chat_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "run" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "run_command" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "run_event" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX "chat_thread_current_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "chat_thread_current_uidx" ON "chat_thread" ("workspace_id","chat_id") WHERE "is_current" and "chat_id" is not null;--> statement-breakpoint
DROP INDEX "run_task_id_live_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "run_task_id_live_uidx" ON "run" ("task_id") WHERE "status" in ('queued', 'running') and "task_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_session_thread_id_created_at_idx" ON "agent_session" ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "run_thread_id_created_at_idx" ON "run" ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_thread_id_live_uidx" ON "run" ("thread_id") WHERE "status" in ('queued', 'running') and "thread_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "run_command_thread_id_kind_pending_uidx" ON "run_command" ("thread_id","kind") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "run_command_thread_id_created_at_idx" ON "run_command" ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "run_event_thread_id_id_idx" ON "run_event" ("thread_id","id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_thread_fk" FOREIGN KEY ("workspace_id","thread_id") REFERENCES "chat_thread"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_run_id_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_thread_fk" FOREIGN KEY ("workspace_id","thread_id") REFERENCES "chat_thread"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run_command" ADD CONSTRAINT "run_command_thread_fk" FOREIGN KEY ("workspace_id","thread_id") REFERENCES "chat_thread"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_thread_id_chat_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "chat_thread"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_subject_ck" CHECK (("task_id" is null) <> ("thread_id" is null));--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_subject_ck" CHECK (("role" = 'worker') = ("task_id" is not null)
        and ("role" = 'manager') = ("thread_id" is not null));--> statement-breakpoint
ALTER TABLE "run_command" ADD CONSTRAINT "run_command_subject_ck" CHECK (("task_id" is null) <> ("thread_id" is null));--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_subject_ck" CHECK (("task_id" is null) <> ("thread_id" is null));--> statement-breakpoint
ALTER TABLE "agent_session" DROP CONSTRAINT "agent_session_watermark_ck", ADD CONSTRAINT "agent_session_watermark_ck" CHECK (("unread_watermark_id" is null) = ("unread_watermark_at" is null));