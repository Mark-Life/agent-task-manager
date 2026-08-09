CREATE TABLE "proposal" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"body" text NOT NULL,
	"content_hash" text NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"path" text NOT NULL,
	"project_id" uuid,
	"run_id" uuid,
	"scope" text NOT NULL,
	"source_path" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"task_id" uuid NOT NULL,
	CONSTRAINT "proposal_scope_ck" CHECK (("scope" = 'project') = ("project_id" is not null)),
	CONSTRAINT "proposal_decision_ck" CHECK (("state" = 'pending') = ("decided_at" is null)
        and ("decided_at" is null) = ("decided_by" is null)),
	CONSTRAINT "proposal_body_size_ck" CHECK (pg_column_size("body") < 65536)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_task_id_source_path_content_hash_uidx" ON "proposal" ("task_id","source_path","content_hash");--> statement-breakpoint
CREATE INDEX "proposal_workspace_id_created_at_pending_idx" ON "proposal" ("workspace_id","created_at") WHERE "state" = 'pending';--> statement-breakpoint
CREATE INDEX "proposal_task_id_created_at_idx" ON "proposal" ("task_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "proposal_project_id_idx" ON "proposal" ("project_id");--> statement-breakpoint
CREATE INDEX "proposal_run_id_idx" ON "proposal" ("run_id");--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_run_id_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "task"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "project"("workspace_id","id") ON DELETE CASCADE;