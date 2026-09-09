-- The board's own channel, so an open dashboard can be told a card moved
-- instead of asking every ten seconds whether one did.
--
-- The dispatch trigger beside it cannot serve this and should not be widened to
-- try: its `WHEN` clause fires only on a row landing in `in_progress`, because
-- what it wakes is the orchestrator, and a title edit is not a request for a
-- worker slot. A board draws every column, so it has to hear about every change
-- to a card — including the one that takes the card off the board.
--
-- Ids only, and the same reason as everywhere else here: `NOTIFY` has a hard
-- 8000-byte limit, and a card carries a brief. A notice is a nudge to read.
-- The reader is the gateway, which already knows which workspace its subscriber
-- may see, so `workspaceId` is what the filtering is done on and `taskId` is
-- there for a log line that has to name the card.
--
-- Two tables feed it, because two tables answer the question a board asks. The
-- card's column and its rank are on `task`. Whether an agent is working on it
-- right now — the spinner, and the difference between a queued card and a
-- stalled one — is on `run`, which changes without the task row being touched
-- at all.

CREATE FUNCTION notify_board_task() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changed record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed := OLD;
  ELSE
    changed := NEW;
  END IF;
  PERFORM pg_notify('atm_board', json_build_object(
    'taskId', changed.id,
    'workspaceId', changed.workspace_id
  )::text);
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- No `WHEN`. Every write to a card is something the board draws: the column it
-- is in, where it sits in that column, its title, its project, whether the
-- dispatcher has parked it. A clause listing the columns that matter would be a
-- second copy of what a card is, kept in SQL, and wrong the first time one is
-- added.
CREATE TRIGGER task_notify_board AFTER INSERT OR UPDATE OR DELETE ON "task"
  FOR EACH ROW EXECUTE FUNCTION notify_board_task();
--> statement-breakpoint

CREATE FUNCTION notify_board_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('atm_board', json_build_object(
    'taskId', NEW.task_id,
    'workspaceId', NEW.workspace_id
  )::text);
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- A run on a thread is a conversation's turn and sits on no card, so it is
-- filtered out here rather than in the gateway: a manager talking to somebody
-- should not wake every open board in the workspace.
--
-- On status alone for the update, because the rest of what a run collects while
-- it works — its container id, its cost, its token count — is not on the board.
-- A run row deleted needs no notice of its own: runs go when their task does,
-- and the delete above has already said so.
CREATE TRIGGER run_notify_board AFTER INSERT ON "run"
  FOR EACH ROW WHEN (NEW.task_id IS NOT NULL)
  EXECUTE FUNCTION notify_board_run();
--> statement-breakpoint
CREATE TRIGGER run_notify_board_status AFTER UPDATE ON "run"
  FOR EACH ROW WHEN (NEW.task_id IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION notify_board_run();
