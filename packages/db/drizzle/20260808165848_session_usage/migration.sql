CREATE TABLE "agent_session_usage" (
	"session_id" uuid PRIMARY KEY,
	"usage" jsonb NOT NULL,
	"workspace_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_session_usage" ADD CONSTRAINT "agent_session_usage_session_fk" FOREIGN KEY ("workspace_id","session_id") REFERENCES "agent_session"("workspace_id","id") ON DELETE CASCADE;