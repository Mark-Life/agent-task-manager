CREATE TABLE "chat_message" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"body" text NOT NULL,
	"forward_from" text,
	"intake_kind" text,
	"provider_session_id" text,
	"role" text NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"telegram_message_id" bigint,
	"thread_id" uuid NOT NULL,
	"transcript_chars" integer,
	CONSTRAINT "chat_message_intake_ck" CHECK (("role" = 'user') = ("intake_kind" is not null))
);
--> statement-breakpoint
CREATE TABLE "chat_notification" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"run_id" uuid,
	"sent_at" timestamp with time zone,
	"task_id" uuid NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"telegram_message_id" bigint,
	"thread_id" uuid
);
--> statement-breakpoint
CREATE TABLE "chat_thread" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"chat_id" bigint NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text DEFAULT 'claude' NOT NULL,
	"provider_session_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"title" text,
	"user_id" text NOT NULL,
	CONSTRAINT "chat_thread_archived_not_current_ck" CHECK (not ("status" = 'archived' and "is_current"))
);
--> statement-breakpoint
CREATE INDEX "chat_message_thread_id_created_at_id_idx" ON "chat_message" ("thread_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_notification_workspace_id_dedupe_key_uidx" ON "chat_notification" ("workspace_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "chat_notification_unsent_idx" ON "chat_notification" ("workspace_id","created_at") WHERE "sent_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_thread_workspace_id_id_uidx" ON "chat_thread" ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_thread_current_uidx" ON "chat_thread" ("workspace_id","chat_id") WHERE "is_current";--> statement-breakpoint
CREATE INDEX "chat_thread_workspace_id_chat_id_last_message_at_idx" ON "chat_thread" ("workspace_id","chat_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_thread_fk" FOREIGN KEY ("workspace_id","thread_id") REFERENCES "chat_thread"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_notification" ADD CONSTRAINT "chat_notification_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chat_thread" ADD CONSTRAINT "chat_thread_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE RESTRICT;