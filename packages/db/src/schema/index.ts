/**
 * The tables, as drizzle describes them — which is also the line between what
 * the schema owns and what the hand-written migration owns.
 *
 * Everything expressible here lives here: columns, indexes, foreign keys and
 * the CHECK constraints. That matters because the snapshot a generated
 * migration diffs against is built from these files, so an invariant declared
 * anywhere else has no memory of itself and disappears the next time a
 * migration is generated.
 *
 * Three things drizzle cannot express, and they stay in the migration written
 * by hand: the `BEFORE UPDATE` trigger that maintains `updated_at` even for a
 * statement that bypassed the repositories, the `AFTER INSERT` triggers that
 * `pg_notify` a run event, a run command and a task entering dispatch, and the
 * `REVOKE UPDATE, DELETE` on `run_event`, `audit_entry` and `chat_message`
 * that makes append-only a permission rather than a habit.
 */

export { agentSession } from "./agent-session";
export { artifact } from "./artifact";
export { auditEntry } from "./audit";
export {
  account,
  invitation,
  member,
  organization,
  session,
  user,
  verification,
} from "./auth";
export { chatMessage, chatNotification, chatThread } from "./chat";
export { comment } from "./comment";
export { project } from "./project";
export { projectEnvFile } from "./project-env";
export { relations } from "./relations";
export { run, runCommand, runEvent } from "./run";
export { task } from "./task";
