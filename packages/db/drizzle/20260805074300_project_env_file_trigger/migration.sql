-- The half of `project_env_file` drizzle's snapshot cannot see: the trigger
-- that maintains `updated_at`. Written by hand for the same reason the first
-- custom migration was — a trigger is not one of the entity kinds drizzle
-- diffs, so a generated migration can neither emit this nor decide it was
-- deleted.
--
-- The column is what the editor sorts and shows as "last changed", and a run's
-- log line names it, so a stale value here reads as a file nobody has touched
-- since a save that happened this morning.

CREATE TRIGGER project_env_file_set_updated_at BEFORE UPDATE ON "project_env_file"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
