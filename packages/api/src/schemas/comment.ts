/**
 * The task's conversation on the wire.
 *
 * Append only, which is why there is no patch shape and no delete: transcripts
 * are the full record of what happened, and this is the short deliberate thing
 * the next reader needs.
 */

import { Comment as DomainComment } from "@workspace/domain";
import { Schema } from "effect";

/** One message in a task's thread, exactly as the store holds it. */
export const Comment = DomainComment.annotate({ identifier: "Comment" });

export interface Comment extends Schema.Schema.Type<typeof Comment> {}

/**
 * What posting one takes.
 *
 * The author is absent on purpose. It is derived from the credential — a person,
 * the manager speaking for one, or a run naming its own session — so no caller
 * can sign a comment as somebody else, and attribution stays the thing that
 * makes several sessions on one task readable.
 *
 * `kind` is `message` unless said otherwise; `fallback` is the auto-appended
 * final assistant message the UI collapses, and `run_error` is a crash, which
 * it never does.
 */
export const CommentAppend = Schema.Struct({
  body: DomainComment.fields.body,
  kind: Schema.optionalKey(DomainComment.fields.kind),
}).annotate({ identifier: "CommentAppend" });

export interface CommentAppend
  extends Schema.Schema.Type<typeof CommentAppend> {}
