-- The half of "a thread is a dispatch source" that drizzle cannot express: the
-- trigger that wakes the loop when someone says something, and the privileges
-- the loop needs to answer. Written by hand for the same reason the earlier
-- custom migrations were — a trigger is not one of the entity kinds drizzle
-- diffs, so a generated migration can neither emit these nor decide they were
-- deleted.

-- Dispatch, the exact shape of `notify_task_dispatch`. Insert only, and only
-- for a person's message: the manager's own answer is a row in the same table
-- and must not wake the loop to answer itself. Ids only, never the body —
-- NOTIFY has a hard 8000-byte limit and a message has no such bound, so a
-- listener reads the row.
CREATE FUNCTION notify_chat_dispatch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('atm_chat_dispatch', json_build_object(
    'messageId', NEW.id,
    'threadId', NEW.thread_id,
    'workspaceId', NEW.workspace_id
  )::text);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER chat_message_notify_dispatch AFTER INSERT ON "chat_message"
  FOR EACH ROW WHEN (NEW.role = 'user')
  EXECUTE FUNCTION notify_chat_dispatch();
--> statement-breakpoint

-- The loop writes the manager's answer into the conversation and moves the
-- thread up the list when it does, so it needs the two privileges the bot has
-- had all along. `chat_message` stays append-only: this grants INSERT and
-- nothing that could edit what was said. Applied to atm_app if it exists, and
-- a no-op otherwise — the local container connects as the superuser that owns
-- these tables, and a superuser bypasses every privilege check.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atm_app') THEN
    GRANT INSERT ON "chat_message" TO "atm_app";
    GRANT UPDATE ("last_message_at", "title", "updated_at") ON "chat_thread" TO "atm_app";
  END IF;
END;
$$;
