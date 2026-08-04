/**
 * The two columns a subject occupies, in the four tables that carry it.
 *
 * A run works a task or answers a thread, and `agent_session`, `run_event` and
 * `run_command` all denormalize the same pair so a reader can filter one
 * task's or one thread's rows without a join. Spreading the pair from one place
 * is what keeps "exactly one of them is set" true at every write, and it is the
 * same rule the CHECK on each of those tables enforces.
 */

import type { RunSubject } from "@workspace/domain";

/** Exactly one id set, the other null — the shape every subject column pair takes. */
export const subjectColumns = (subject: RunSubject) => ({
  taskId: subject.kind === "task" ? subject.id : null,
  threadId: subject.kind === "thread" ? subject.id : null,
});
