import {
  FileScopeAddress,
  ProjectId,
  RunId,
  ScopePath,
  TaskId,
  ThreadId,
} from "@workspace/domain";
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

const decodeFileScope = Schema.decodeUnknownOption(FileScopeAddress);

/**
 * The directory of the agent filesystem a browser is open on, decoded into the
 * union every file route takes.
 *
 * Null rather than a throw, for the same reason every other parser here degrades
 * quietly: `?scope=project:nonsense` is a link somebody truncated, and the
 * screen answers it by opening the workspace rather than by an error page.
 */
export const fileScopeOf = (value: unknown) =>
  Option.getOrNull(decodeFileScope(value));

/**
 * The same scope, kept as the one segment the URL carries.
 *
 * The address stays a string in the search parameters rather than becoming the
 * union it decodes to: what goes back into the address bar is whatever the
 * typed search holds, and an object there would put JSON in the URL where
 * `project:<id>` belongs.
 */
export const parseFileScopeAddress = (value: unknown) =>
  typeof value === "string" && fileScopeOf(value) !== null ? value : undefined;

/** The file inside that scope the browser has open, if the URL names one it could address. */
export const parseScopePath = optional(Schema.decodeUnknownOption(ScopePath));

/**
 * The two things one directory of the agent filesystem is opened for.
 *
 * Files first, and what the screen falls back to: the tree is the directory
 * itself, and skills are files in it under two known paths. Both are in the URL
 * because both are things one operator sends another — "install this here" is a
 * link, not an instruction to click twice.
 */
export const SCOPE_VIEWS = ["files", "skills"] as const;

/** Which of the two a scope is open on. */
export type ScopeView = (typeof SCOPE_VIEWS)[number];

/** The view a URL asks for, or undefined when it asks for nothing sensible. */
export const parseScopeView = (value: unknown) =>
  SCOPE_VIEWS.find((view) => view === value);

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
  "proposals",
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

/**
 * The two readings of a run's event stream.
 *
 * Chat first, and what a run opens on: the question a reader arrives with is
 * what the agent did, and a conversation answers that where a line per event
 * makes them assemble it. The table is the second reading, for when the first
 * has smoothed over the thing they need — and it is in the URL rather than in
 * the panel's own state for the same reason the open tab is, because a link to
 * a run is something one operator sends another and it should open the way the
 * sender was reading it.
 */
export const RUN_VIEWS = ["chat", "table"] as const;

/** Which reading of a run is on screen. */
export type RunView = (typeof RUN_VIEWS)[number];

/** The reading a URL asks for, or undefined when it asks for nothing sensible. */
export const parseRunView = (value: unknown) =>
  RUN_VIEWS.find((view) => view === value);
