-- The half of `proposal` drizzle's snapshot cannot see: the trigger that
-- maintains `updated_at`. Written by hand for the same reason every custom
-- migration here is — a trigger is not one of the entity kinds drizzle diffs,
-- so a generated migration can neither emit this nor decide it was deleted.
--
-- A proposal is written once and updated once, when a person answers it, and
-- the column is what the queue sorts by and what says how long a request has
-- been waiting. A stale value would make an answered proposal read as one
-- nobody has looked at.

CREATE TRIGGER proposal_set_updated_at BEFORE UPDATE ON "proposal"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
