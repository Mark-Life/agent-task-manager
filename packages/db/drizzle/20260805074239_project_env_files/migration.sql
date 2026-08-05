CREATE TABLE "project_env_file" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_enc" bytea NOT NULL,
	"key_version" smallint NOT NULL,
	"path" text NOT NULL,
	"project_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "project_env_file_project_id_path_uidx" ON "project_env_file" ("workspace_id","project_id","path");--> statement-breakpoint
ALTER TABLE "project_env_file" ADD CONSTRAINT "project_env_file_workspace_id_organization_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "organization"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "project_env_file" ADD CONSTRAINT "project_env_file_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "project"("workspace_id","id") ON DELETE CASCADE;