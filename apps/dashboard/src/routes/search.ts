import { ProjectId, RunId, TaskId, ThreadId } from "@workspace/domain";
import { Option, Schema } from "effect";

/**
 * A URL is something a person can type, truncate or paste half of, so every
 * value read out of one is treated as unknown until the domain's own schema has
 * agreed with it. Turning a mismatch into `undefined` rather than a thrown
 * error is what makes a mangled link degrade into the unfiltered screen instead
 * of an error page.
 */
const optional =
  <A>(decode: (value: unknown) => Option.Option<A>) =>
  (value: unknown) =>
    Option.getOrUndefined(decode(value));

/** The project the board is narrowed to, if the URL names one that could exist. */
export const parseProjectId = optional(Schema.decodeUnknownOption(ProjectId));

/**
 * The text the board is searched by. A plain string rather than a schema
 * value: anything a person can type is a valid search, and the worst one finds
 * is nothing.
 */
export const parseSearchText = (value: unknown) =>
  typeof value === "string" ? value : undefined;

/** The task a detail page is about. */
export const parseTaskId = optional(Schema.decodeUnknownOption(TaskId));

/** The attempt a timeline is showing, when the reader picked one. */
export const parseRunId = optional(Schema.decodeUnknownOption(RunId));

/** The conversation the overlay is open on. */
export const parseThreadId = optional(Schema.decodeUnknownOption(ThreadId));

/**
 * The panels of a task page, in the order they are drawn.
 *
 * Details comes first, and is what a task opens on when the link asks for
 * nothing else: it is what the task *is* — its brief, what it will be judged
 * by, the fields it sits under — and the panel that answers "what is this"
 * for a reader who has just clicked a card they did not write.
 */
export const TASK_TABS = [
  "details",
  "messages",
  "runs",
  "sessions",
  "artifacts",
] as const;

/** Which panel of a task page is open. */
export type TaskTab = (typeof TASK_TABS)[number];

/**
 * Name to panel, so an unknown string reads back as a plain absent value. The
 * messages panel answers to its old name as well: links to `?tab=comments` are
 * already in people's history and in whatever they pasted into a chat.
 */
const BY_NAME: Record<string, TaskTab> = {
  ...Object.fromEntries(TASK_TABS.map((tab) => [tab, tab])),
  comments: "messages",
};

/** The panel a URL asks for, or undefined when it asks for nothing sensible. */
export const parseTaskTab = (value: unknown) =>
  typeof value === "string" ? BY_NAME[value] : undefined;
