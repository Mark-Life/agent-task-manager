-- What drizzle cannot express, and therefore what a generated migration can
-- never emit, drop, or diff: triggers, the functions they call, and privileges.
-- A trigger is not one of the entity kinds in drizzle's snapshot, so the next
-- `drizzle-kit generate` cannot see these and cannot decide they were deleted.
-- The one case that does destroy them is a later migration that drops and
-- recreates one of these tables, since Postgres drops a table's triggers with
-- it. Watch for a DROP TABLE on task, run_event, run_command or any mutable
-- table in a generated diff.
--
-- A new mutable table added later does not get its updated_at trigger for free.
-- It needs a line in a new custom migration, and that is the running cost of
-- drizzle having no builder for this.

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Maintained by the database rather than by application code, so a statement
-- that bypassed the repositories cannot leave the column stale. The columns
-- exist on every table of ours that is not append-only; the auth library's
-- tables are left alone, because it writes their timestamps itself.
CREATE TRIGGER project_set_updated_at BEFORE UPDATE ON "project"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER task_set_updated_at BEFORE UPDATE ON "task"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER comment_set_updated_at BEFORE UPDATE ON "comment"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER agent_session_set_updated_at BEFORE UPDATE ON "agent_session"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER run_set_updated_at BEFORE UPDATE ON "run"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER run_command_set_updated_at BEFORE UPDATE ON "run_command"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER artifact_set_updated_at BEFORE UPDATE ON "artifact"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- The event bus. Ids only, never the payload: NOTIFY has a hard 8000-byte limit
-- and a run event's blob is allowed up to 64 KB, so carrying it would fail at
-- exactly the moment a run got interesting. A listener reads the row.
CREATE FUNCTION notify_run_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('atm_run_event', json_build_object(
    'id', NEW.id,
    'runId', NEW.run_id,
    'taskId', NEW.task_id,
    'workspaceId', NEW.workspace_id,
    'seq', NEW.seq,
    'kind', NEW.kind
  )::text);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER run_event_notify AFTER INSERT ON "run_event"
  FOR EACH ROW EXECUTE FUNCTION notify_run_event();
--> statement-breakpoint

CREATE FUNCTION notify_run_command() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('atm_run_command', json_build_object(
    'id', NEW.id,
    'taskId', NEW.task_id,
    'runId', NEW.run_id,
    'workspaceId', NEW.workspace_id,
    'kind', NEW.kind
  )::text);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER run_command_notify AFTER INSERT ON "run_command"
  FOR EACH ROW EXECUTE FUNCTION notify_run_command();
--> statement-breakpoint

-- Dispatch. Insert as well as update, because a task can be created straight
-- into the column; the WHEN clause is what keeps an ordinary edit to a running
-- task from waking the orchestrator.
CREATE FUNCTION notify_task_dispatch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('atm_task_dispatch', json_build_object(
    'taskId', NEW.id,
    'workspaceId', NEW.workspace_id,
    'rank', NEW.rank
  )::text);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER task_notify_dispatch AFTER INSERT ON "task"
  FOR EACH ROW WHEN (NEW.status = 'in_progress')
  EXECUTE FUNCTION notify_task_dispatch();
--> statement-breakpoint
CREATE TRIGGER task_notify_dispatch_move AFTER UPDATE ON "task"
  FOR EACH ROW WHEN (NEW.status = 'in_progress' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION notify_task_dispatch();
--> statement-breakpoint

-- Append-only as a permission rather than a habit. Applied to atm_app if it
-- exists, and a no-op otherwise: the local container connects as the superuser
-- that owns these tables, and a superuser bypasses every privilege check, so
-- this only becomes real once the application has a login role of its own.
-- Until then the rule is the repositories', which never issue the statements.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atm_app') THEN
    REVOKE UPDATE, DELETE ON "run_event", "audit_entry" FROM "atm_app";
  END IF;
END;
$$;
