/**
 * The task's conversation on the wire.
 *
 * Append only, which is why there is no patch shape and no delete: transcripts
 * are the full record of what happened, and this is the short deliberate thing
 * the next reader needs.
 */

import { TaskMessage as DomainTaskMessage } from "@workspace/domain";
import { Schema } from "effect";

/** One message in a task's thread, exactly as the store holds it. */
export const TaskMessage = DomainTaskMessage.annotate({
  identifier: "TaskMessage",
});

export interface TaskMessage extends Schema.Schema.Type<typeof TaskMessage> {}

/**
 * What posting one takes.
 *
 * The author is absent on purpose. It is derived from the credential — a person,
 * the manager speaking for one, or a run naming its own session — so no caller
 * can sign a message as somebody else, and attribution stays the thing that
 * makes several sessions on one task readable.
 *
 * `kind` is `message` unless said otherwise; `fallback` is the auto-appended
 * final assistant message the UI collapses, and `run_error` is a crash, which
 * it never does.
 */
export const TaskMessagePost = Schema.Struct({
  body: DomainTaskMessage.fields.body,
  kind: Schema.optionalKey(DomainTaskMessage.fields.kind),
}).annotate({ identifier: "TaskMessagePost" });

export interface TaskMessagePost
  extends Schema.Schema.Type<typeof TaskMessagePost> {}
