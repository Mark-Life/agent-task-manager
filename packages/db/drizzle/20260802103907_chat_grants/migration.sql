-- The half of the chat tables drizzle's snapshot cannot see: the triggers that
-- maintain `updated_at`, and the privileges that make `chat_message`
-- append-only. Written by hand for the same reason the first custom migration
-- was — a trigger is not one of the entity kinds drizzle diffs, so a generated
-- migration can neither emit these nor decide they were deleted.

-- Maintained by the database rather than by application code, so a statement
-- that bypassed the repositories cannot leave the column stale.
CREATE TRIGGER chat_thread_set_updated_at BEFORE UPDATE ON "chat_thread"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TRIGGER chat_notification_set_updated_at BEFORE UPDATE ON "chat_notification"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- What was said is append-only as a permission rather than a habit: nothing
-- edits a message, and a conversation the manager reads back as its own memory
-- must be the conversation that happened. Applied to atm_app if it exists, and
-- a no-op otherwise — the local container connects as the superuser that owns
-- these tables, and a superuser bypasses every privilege check.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atm_app') THEN
    REVOKE UPDATE, DELETE ON "chat_message" FROM "atm_app";
  END IF;
END;
$$;
