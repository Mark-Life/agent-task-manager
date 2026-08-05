/**
 * A project's environment files on the way into a run, and the values from them
 * on the way back out of one.
 *
 * **Two directions, one list.** The files go in: read for the run's project,
 * decrypted by the store, handed to materialization as plain `{path, content}`
 * so `@workspace/sandbox` never learns where they came from. The values come
 * back out: the agent can read the files — that is the entire point of writing
 * them — so the moment it runs `cat .env`, the value is in a tool result, in the
 * transcript, and on its way into Postgres in the clear, forever. This module
 * holds both halves because they are the same list read twice.
 *
 * **What the redaction is, and what it is not.** It is a replacement of exact
 * matches of this run's own secret values with a marker, over text that is about
 * to be stored. It is not a filter and it does not pretend to be: a value the
 * agent reformats, base64s, or prints one character per line survives it. It is
 * worth doing anyway because `cat .env` is the case that actually happens, and
 * the alternative is a timeline that cannot be shown to anyone.
 *
 * The values are the right-hand sides, not the whole file. A file redacted
 * whole would only ever match if the agent printed it byte for byte, and the
 * key names are what make a redacted line readable — `DATABASE_URL=[redacted]`
 * says what was hidden, which is what a person reading a timeline needs.
 *
 * Short values are left alone. A `NODE_ENV=test` redacted everywhere would
 * scrub the word "test" out of every log line in the run, and the value it
 * protects is not a secret.
 */

import { ProjectEnvFileRepo } from "@workspace/db";
import type { EnvFileWrite } from "@workspace/domain";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
  type DispatchContext,
  projectIdOf,
  subjectOf,
  workspaceIdOf,
} from "./dispatch-context";
import { DispatchFailed } from "./errors";

/** What replaces a value that leaked into text on its way to storage. */
export const REDACTION_MARKER = "[redacted]";

/**
 * The shortest value worth hiding.
 *
 * Below this the string is a flag or a port, and replacing every occurrence of
 * it does more damage to the timeline than the value could ever do to the
 * operator. Twelve characters is longer than every enum a `.env` holds and
 * shorter than every key, URL and password one holds.
 */
export const REDACTABLE_MIN_CHARS = 12;

/** Strips one layer of matching quotes, which is how a shell reads the same line. */
const unquoted = (value: string) => {
  const quote = value.at(0);
  return (quote === '"' || quote === "'") &&
    value.endsWith(quote) &&
    value.length > 1
    ? value.slice(1, -1)
    : value;
};

/** The `export ` a line may carry, which a shell strips and so does this. */
const EXPORT_PREFIX = /^export\s+/;

/**
 * The value one `.env` line assigns, or null for a line that assigns nothing —
 * a comment, a blank, or a continuation of a multi-line value.
 *
 * Deliberately not a full dotenv parser. What this needs is "which substrings of
 * this file must never appear in a transcript", and for that a line that is read
 * wrongly costs one unredacted value, while a dependency on a parser costs a
 * behaviour that changes under an upgrade.
 */
const valueOfLine = (line: string): string | null => {
  const trimmed = line.trim().replace(EXPORT_PREFIX, "");
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return null;
  }
  const separator = trimmed.indexOf("=");
  if (separator < 0) {
    return null;
  }
  const value = unquoted(trimmed.slice(separator + 1).trim());
  return value.length === 0 ? null : value;
};

/**
 * Every value the files assign, longest first, deduplicated.
 *
 * Longest first is what makes the replacement stable: two variables often share
 * a prefix — a base URL and the same URL with a path — and replacing the
 * shorter one first leaves the tail of the longer one in the text beside a
 * marker, which reads as redacted and is not.
 */
export const secretValuesOf = (
  files: readonly EnvFileWrite[]
): readonly string[] => {
  const values = new Set<string>();
  for (const file of files) {
    for (const line of file.content.split("\n")) {
      const value = valueOfLine(line);
      if (value !== null && value.length >= REDACTABLE_MIN_CHARS) {
        values.add(value);
      }
    }
  }
  return [...values].sort((left, right) => right.length - left.length);
};

/** Replaces every occurrence of every value with the marker. */
const replaceAll = (text: string, values: readonly string[]) =>
  values.reduce(
    (carried, value) => carried.split(value).join(REDACTION_MARKER),
    text
  );

/**
 * Redacts this run's own secret values out of text about to be stored, or
 * returns the text untouched when the run holds none.
 *
 * Built once per run and applied per string, because the common case is a run
 * with no env files at all and the common case should cost nothing.
 */
export const makeRedactor = (values: readonly string[]) =>
  values.length === 0
    ? (text: string) => text
    : (text: string) => replaceAll(text, values);

/** What {@link makeRedactor} produces: a total function over one string. */
export type Redactor = ReturnType<typeof makeRedactor>;

/**
 * The same replacement over every string inside a value of arbitrary shape.
 *
 * Structural rather than field-by-field, because the thing it is applied to is
 * a run event payload — a closed union whose members each carry their own text
 * fields, and a mapping that named them would silently stop covering a member
 * added later. Keys are left alone: a key is a name this code chose, and a
 * secret value that happens to equal one would be a coincidence worth leaving
 * visible rather than a leak.
 */
export const redactDeep = <A>(value: A, redact: Redactor): A => {
  if (typeof value === "string") {
    return redact(value) as A;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, redact)) as A;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactDeep(item, redact),
      ])
    ) as A;
  }
  return value;
};

/**
 * Rewrites the run's own files with this run's secret values replaced.
 *
 * The rows the loop wrote as the stream arrived are already redacted; these are
 * the copies on disk that outlive the container — the normalized event file the
 * container itself appended to, and the transcript copied out of the agent
 * home. Scrubbing them is what makes a re-ingest weeks later write the same
 * redacted rows the first pass did, instead of quietly restoring every secret
 * the agent printed.
 *
 * In place, and only where something actually changed: an unchanged file is not
 * rewritten, so a run that printed nothing pays one read. A file that cannot be
 * read or written is a warning and nothing more — the run is over, and losing
 * the scrub of a file must not turn that into a run that failed to close.
 *
 * The provider's own transcript inside the shared agent home is deliberately
 * not touched. It belongs to the vendor's directory, every run on the host
 * writes into it, and rewriting another process's file is worse than the leak
 * it would close.
 */
export const scrubRunFiles = Effect.fnUntraced(function* (input: {
  readonly paths: readonly string[];
  readonly redact: Redactor;
}) {
  const fs = yield* FileSystem;

  const scrubOne = (path: string) =>
    fs.readFileString(path).pipe(
      Effect.flatMap((text) => {
        const scrubbed = input.redact(text);
        return scrubbed === text
          ? Effect.succeed(false)
          : Effect.as(fs.writeFileString(path, scrubbed), true);
      }),
      Effect.tapError((cause) =>
        Effect.logWarning("run file not scrubbed of the project's secrets", {
          cause,
          path,
        })
      ),
      Effect.orElseSucceed(() => false)
    );

  const scrubbed = yield* Effect.forEach(input.paths, scrubOne);
  return scrubbed.filter(Boolean).length;
});

/**
 * The environment files this run's project holds, decrypted.
 *
 * Empty for a chat turn and for a task that belongs to no project, and neither
 * is a special case worth a branch anywhere below: there is one list, and it is
 * sometimes empty.
 *
 * A store failure fails the dispatch rather than starting a run without the
 * files. The alternative is a container that boots, an agent that cannot reach
 * the database the operator configured for it, and a debugging session about a
 * connection error — for files that are visibly there in the dashboard.
 */
export const projectEnvFilesFor = Effect.fnUntraced(function* (
  context: DispatchContext
) {
  const projectId = projectIdOf(context);
  if (projectId === null) {
    return [] as readonly EnvFileWrite[];
  }
  const files = yield* ProjectEnvFileRepo;
  const stored = yield* files
    .contents({ projectId, workspaceId: workspaceIdOf(context) })
    .pipe(
      Effect.mapError(
        (cause) =>
          new DispatchFailed({
            cause,
            detail: "the project's environment files could not be read",
            subject: subjectOf(context),
          })
      )
    );
  return stored.map(
    (file) =>
      ({ content: file.content, path: file.path }) satisfies EnvFileWrite
  );
});
