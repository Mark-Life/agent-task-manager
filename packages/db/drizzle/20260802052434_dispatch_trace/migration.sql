ALTER TABLE "run_command" ADD COLUMN "traceparent" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "dispatch_traceparent" text;