ALTER TABLE "task" ADD COLUMN "pr_etag" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "pr_state" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "pr_state_at" timestamp with time zone;