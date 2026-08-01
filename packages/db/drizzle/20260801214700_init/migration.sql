CREATE TABLE "account" (
	"access_token" text,
	"access_token_expires_at" timestamp,
	"created_at" timestamp NOT NULL,
	"id" text PRIMARY KEY,
	"id_token" text,
	"issuer" text NOT NULL,
	"password" text,
	"provider_account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"refresh_token" text,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"updated_at" timestamp NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_session" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"comment_watermark_at" timestamp with time zone,
	"comment_watermark_id" uuid,
	"ended_at" timestamp with time zone,
	"error_message" text,
	"provider" text NOT NULL,
	"provider_session_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"task_id" uuid NOT NULL,
	CONSTRAINT "agent_session_ended_ck" CHECK (("status" = 'running') = ("ended_at" is null)),
	CONSTRAINT "agent_session_watermark_ck" CHECK (("comment_watermark_id" is null) = ("comment_watermark_at" is null))
);
--> statement-breakpoint
CREATE TABLE "artifact" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"bytes" bigint NOT NULL,
	"content_hash" text,
	"ext" text,
	"last_run_id" uuid,
	"modified_at" timestamp with time zone NOT NULL,
	"path" text NOT NULL,
	"project_id" uuid,
	"promoted_at" timestamp with time zone,
	"scope" text DEFAULT 'task' NOT NULL,
	"source_artifact_id" uuid,
	"task_id" uuid,
	CONSTRAINT "artifact_task_scope_ck" CHECK (("scope" = 'task') = ("task_id" is not null)),
	CONSTRAINT "artifact_project_scope_ck" CHECK (("scope" = 'project') = ("project_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "audit_entry" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_run_id" uuid,
	"actor_session_id" uuid,
	"actor_thread_id" text,
	"actor_user_id" text,
	"changes" jsonb DEFAULT '{}' NOT NULL,
	"entity_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"from_status" text,
	"task_id" uuid,
	"to_status" text,
	"trace_id" text
);
--> statement-breakpoint
CREATE TABLE "comment" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_session_id" uuid,
	"author_kind" text NOT NULL,
	"author_user_id" text,
	"body" text NOT NULL,
	"kind" text DEFAULT 'message' NOT NULL,
	"run_id" uuid,
	"task_id" uuid NOT NULL,
	CONSTRAINT "comment_author_user_ck" CHECK (("author_kind" in ('human','manager')) = ("author_user_id" is not null)),
	CONSTRAINT "comment_author_session_ck" CHECK (("author_kind" = 'agent') = ("agent_session_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"created_at" timestamp NOT NULL,
	"email" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"id" text PRIMARY KEY,
	"inviter_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"created_at" timestamp NOT NULL,
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"created_at" timestamp NOT NULL,
	"id" text PRIMARY KEY,
	"logo" text,
	"metadata" text,
	"name" text NOT NULL,
	"slug" text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE TABLE "project" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text,
	"name" text NOT NULL,
	"repo_default_branch" text,
	"repo_url" text
);
--> statement-breakpoint
CREATE TABLE "run" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_home_path" text,
	"agent_session_id" uuid NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"branch" text,
	"container_id" text,
	"cost_usd" numeric(12,6),
	"duration_ms" integer,
	"error_class" text,
	"error_message" text,
	"exit_code" integer,
	"finished_at" timestamp with time zone,
	"model" text,
	"outcome" text,
	"provider" text NOT NULL,
	"sandbox_image" text,
	"started_at" timestamp with time zone,
	"status" text DEFAULT 'queued' NOT NULL,
	"task_id" uuid NOT NULL,
	"total_tokens" integer,
	"trace_id" text,
	"trigger" text NOT NULL,
	"turns" integer,
	CONSTRAINT "run_outcome_ck" CHECK (("outcome" is null) = ("status" in ('queued', 'running'))),
	CONSTRAINT "run_finished_at_ck" CHECK (("finished_at" is null) = ("status" in ('queued', 'running'))),
	CONSTRAINT "run_started_at_ck" CHECK ("status" <> 'running' or "started_at" is not null),
	CONSTRAINT "run_queued_ck" CHECK ("status" <> 'queued' or "started_at" is null)
);
--> statement-breakpoint
CREATE TABLE "run_command" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_run_id" uuid,
	"actor_session_id" uuid,
	"actor_user_id" text,
	"consumed_at" timestamp with time zone,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"rejected_reason" text,
	"run_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"task_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_event" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"task_id" uuid NOT NULL,
	CONSTRAINT "run_event_payload_size_ck" CHECK (pg_column_size("payload") < 65536)
);
--> statement-breakpoint
CREATE TABLE "session" (
	"active_organization_id" text,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"id" text PRIMARY KEY,
	"ip_address" text,
	"token" text NOT NULL UNIQUE,
	"updated_at" timestamp NOT NULL,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acceptance" text,
	"brief" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"next_session_id" uuid,
	"next_session_new" boolean DEFAULT false NOT NULL,
	"parent_task_id" uuid,
	"parked_until" timestamp with time zone,
	"project_id" uuid,
	"pr_url" text,
	"rank" double precision NOT NULL,
	"repo_url" text,
	"sandbox_image" text,
	"status" text DEFAULT 'ideas' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	CONSTRAINT "task_next_session_ck" CHECK (not ("next_session_new" and "next_session_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "user" (
	"created_at" timestamp NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"id" text PRIMARY KEY,
	"image" text,
	"name" text NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"updated_at" timestamp NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_providerAccountId_uidx" ON "account" ("issuer","provider_account_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_workspace_id_id_uidx" ON "agent_session" ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "agent_session_task_id_created_at_idx" ON "agent_session" ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_task_id_path_uidx" ON "artifact" ("task_id","path") WHERE "scope" = 'task';--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_project_id_path_uidx" ON "artifact" ("project_id","path") WHERE "scope" = 'project';--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_workspace_id_path_uidx" ON "artifact" ("workspace_id","path") WHERE "scope" = 'global';--> statement-breakpoint
CREATE INDEX "artifact_task_id_modified_at_idx" ON "artifact" ("task_id","modified_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "artifact_project_id_idx" ON "artifact" ("project_id");--> statement-breakpoint
CREATE INDEX "artifact_last_run_id_idx" ON "artifact" ("last_run_id");--> statement-breakpoint
CREATE INDEX "artifact_source_artifact_id_idx" ON "artifact" ("source_artifact_id");--> statement-breakpoint
CREATE INDEX "audit_entry_entity_id_created_at_idx" ON "audit_entry" ("entity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_entry_task_id_created_at_idx" ON "audit_entry" ("task_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_entry_workspace_id_created_at_idx" ON "audit_entry" ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "comment_task_id_created_at_id_idx" ON "comment" ("task_id","created_at","id");--> statement-breakpoint
CREATE INDEX "comment_agent_session_id_idx" ON "comment" ("agent_session_id");--> statement-breakpoint
CREATE INDEX "comment_run_id_idx" ON "comment" ("run_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_org_user_uq" ON "member" ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uidx" ON "organization" ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "project_workspace_id_id_uidx" ON "project" ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_workspace_id_id_uidx" ON "run" ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "run_task_id_created_at_idx" ON "run" ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_task_id_live_uidx" ON "run" ("task_id") WHERE "status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "run_workspace_id_created_at_live_idx" ON "run" ("workspace_id","created_at") WHERE "status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "run_agent_session_id_idx" ON "run" ("agent_session_id");--> statement-breakpoint
CREATE INDEX "run_command_workspace_id_created_at_pending_idx" ON "run_command" ("workspace_id","created_at") WHERE "status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "run_command_task_id_kind_pending_uidx" ON "run_command" ("task_id","kind") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "run_command_task_id_created_at_idx" ON "run_command" ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "run_command_run_id_idx" ON "run_command" ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_event_run_id_seq_uidx" ON "run_event" ("run_id","seq");--> statement-breakpoint
CREATE INDEX "run_event_task_id_id_idx" ON "run_event" ("task_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_workspace_id_id_uidx" ON "task" ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "task_workspace_id_status_rank_idx" ON "task" ("workspace_id","status","rank","created_at");--> statement-breakpoint
CREATE INDEX "task_workspace_id_project_id_status_idx" ON "task" ("workspace_id","project_id","status");--> statement-breakpoint
CREATE INDEX "task_workspace_id_status_status_changed_at_idx" ON "task" ("workspace_id","status","status_changed_at");--> statement-breakpoint
CREATE INDEX "task_parent_task_id_idx" ON "task" ("parent_task_id");--> statement-breakpoint
CREATE INDEX "task_project_id_idx" ON "task" ("project_id");--> statement-breakpoint
CREATE INDEX "task_next_session_id_idx" ON "task" ("next_session_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "task"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_last_run_id_run_id_fkey" FOREIGN KEY ("last_run_id") REFERENCES "run"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_source_artifact_id_artifact_id_fkey" FOREIGN KEY ("source_artifact_id") REFERENCES "artifact"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_task_id_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "audit_entry" ADD CONSTRAINT "audit_entry_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_agent_session_id_agent_session_id_fkey" FOREIGN KEY ("agent_session_id") REFERENCES "agent_session"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_run_id_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "task"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_agent_session_id_agent_session_id_fkey" FOREIGN KEY ("agent_session_id") REFERENCES "agent_session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "task"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run_command" ADD CONSTRAINT "run_command_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "run_command" ADD CONSTRAINT "run_command_run_id_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run_command" ADD CONSTRAINT "run_command_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "task"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_task_id_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "run"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_next_session_id_agent_session_id_fkey" FOREIGN KEY ("next_session_id") REFERENCES "agent_session"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_parent_task_id_task_id_fkey" FOREIGN KEY ("parent_task_id") REFERENCES "task"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "project"("workspace_id","id") ON DELETE SET NULL;