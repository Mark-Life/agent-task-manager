/**
 * The 64 bytes a tapped button sends back, and the only place they are read.
 *
 * Telegram hands `callback_data` back verbatim, and it arrives from the client,
 * not from us — an old message can be tapped days later, and a crafted update
 * can carry anything at all inside the cap. So the string is *parsed*, never
 * cast: the verb is a closed literal set, the argument is decoded through the
 * branded id schema it claims to be, and a page number is a bounded natural.
 * What a handler receives is a value that has already been proven, which is why
 * the handlers can be a plain `switch` with no validation in them.
 *
 * The wire shape is `v1:<verb>:<arg>` — flat, because 64 bytes is not enough
 * for JSON and a base64 blob is a thing nobody can read in a bug report. A uuid
 * is 36 of those bytes, which leaves room for exactly one prefix and one verb,
 * and is why the argument is an id rather than a payload. Anything a button
 * needs beyond an id is looked up from the id.
 *
 * The `v1` prefix is what makes changing the shape survivable: a button minted
 * by an older build decodes as `None` and gets "that button has expired"
 * instead of acting on a misread argument.
 */

import { TaskId, ThreadId } from "@workspace/domain";
import { Option, Schema } from "effect";

/** The wire-format generation. Bump it when a verb's argument changes meaning. */
export const CALLBACK_VERSION = "v1";

/** Telegram's hard cap on `callback_data`, in bytes. */
export const CALLBACK_DATA_MAX_BYTES = 64;

/** The buttons that act on one task. Short because the budget is 64 bytes. */
export const TASK_VERBS = [
  /** Move the task to `in_progress`. */
  "tprog",
  /** Move the task to `review`. */
  "trev",
  /** Move the task to `done`. */
  "tdone",
  /** Queue a stop command for the task's live run. */
  "rstop",
  /** Queue a rerun command for the task. */
  "rrun",
  /** Arm the chat to turn the next message into a comment on the task. */
  "cadd",
] as const;

/** The buttons that act on one conversation. */
export const THREAD_VERBS = [
  /** Make this conversation the chat's current one. */
  "thsw",
  /** Stop the turn running in it, so what is queued behind it is read next. */
  "thfs",
] as const;

/** The lists that paginate in place. Closed, because the key picks a renderer. */
export const PAGE_KEYS = ["threads", "history", "tasks", "board"] as const;

/** Highest page a button may address, so a crafted callback cannot ask for a huge offset. */
export const MAX_PAGE = 999;

/** A button that acts on one task. */
const TaskCallback = Schema.Struct({
  kind: Schema.tag("task"),
  taskId: TaskId,
  verb: Schema.Literals(TASK_VERBS),
});

/** A button that acts on one conversation. */
const ThreadCallback = Schema.Struct({
  kind: Schema.tag("thread"),
  threadId: ThreadId,
  verb: Schema.Literals(THREAD_VERBS),
});

/** A button that re-renders a paginated list in place. */
const PageCallback = Schema.Struct({
  key: Schema.Literals(PAGE_KEYS),
  kind: Schema.tag("page"),
  page: Schema.Natural.pipe(Schema.check(Schema.isLessThanOrEqualTo(MAX_PAGE))),
  verb: Schema.tag("pg"),
});

/** Everything a button in this app can mean, once it has been proven. */
export const CallbackData = Schema.Union([
  TaskCallback,
  ThreadCallback,
  PageCallback,
]).pipe(Schema.toTaggedUnion("kind"));
export type CallbackData = typeof CallbackData.Type;

/** A task-scoped verb, derived so the button table and the router cannot drift. */
export type TaskVerb = (typeof TASK_VERBS)[number];

/** A conversation-scoped verb, derived the same way. */
export type ThreadVerb = (typeof THREAD_VERBS)[number];

/** Which paginated list a page button belongs to. */
export type PageKey = (typeof PAGE_KEYS)[number];

/** Decode a proven value from an already-validated shape, or `None`. */
const decodeCallback = Schema.decodeUnknownOption(CallbackData);

/**
 * Render a callback value as the string a button carries.
 *
 * The length is asserted rather than trusted: Telegram rejects the whole
 * `sendMessage` when one button's data is over the cap, so an oversized button
 * takes the message with it, and finding that at the send site is finding it
 * one layer too late.
 */
/** The argument half of a callback string, one case per member of the union. */
const argumentOf = (data: CallbackData) => {
  switch (data.kind) {
    case "task":
      return data.taskId;
    case "thread":
      return data.threadId;
    default:
      return `${data.key}:${data.page}`;
  }
};

export const encodeCallbackData = (data: CallbackData) => {
  const encoded = `${CALLBACK_VERSION}:${data.verb}:${argumentOf(data)}`;
  if (Buffer.byteLength(encoded, "utf8") > CALLBACK_DATA_MAX_BYTES) {
    throw new Error(`callback data over ${CALLBACK_DATA_MAX_BYTES} bytes`);
  }
  return encoded;
};

/** The `{ verb, rest }` split of a well-formed callback string, or `None`. */
const splitCallback = (raw: string) => {
  const [version, verb, ...rest] = raw.split(":");
  return version === CALLBACK_VERSION && verb !== undefined && rest.length > 0
    ? Option.some({ rest, verb })
    : Option.none();
};

/** The unvalidated object a raw callback string claims to be. */
const shapeOf = (parts: { readonly rest: string[]; readonly verb: string }) => {
  if ((TASK_VERBS as readonly string[]).includes(parts.verb)) {
    return { kind: "task", taskId: parts.rest[0], verb: parts.verb };
  }
  if ((THREAD_VERBS as readonly string[]).includes(parts.verb)) {
    return { kind: "thread", threadId: parts.rest[0], verb: parts.verb };
  }
  if (parts.verb === "pg") {
    return {
      key: parts.rest[0],
      kind: "page",
      page: Number(parts.rest[1]),
      verb: parts.verb,
    };
  }
  return null;
};

/**
 * Parse what a tap sent back.
 *
 * `None` covers every way a button can be wrong at once — a bumped version, a
 * retired verb, an argument that is not a uuid, a page past the cap — because
 * the answer is the same in all of them and telling them apart would only tell
 * a prober which guess was closer.
 */
export const decodeCallbackData = (raw: string | undefined) =>
  Option.fromNullishOr(raw).pipe(
    Option.flatMap(splitCallback),
    Option.flatMap((parts) => Option.fromNullOr(shapeOf(parts))),
    Option.flatMap(decodeCallback)
  );
