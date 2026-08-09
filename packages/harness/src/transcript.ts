/**
 * What a provider wrote to disk while it worked, read back as one shape.
 *
 * The normalized event stream is what the system runs on, but it only exists
 * while the harness is alive to emit it. The transcript is the other record:
 * the provider writes it itself, it survives the container, and it is the only
 * thing left when a run is killed between two events. So the reader exists for
 * the cases the stream cannot answer — reconstructing a lost run, auditing what
 * an agent actually did, and re-ingesting a run whose event file never made it
 * back.
 *
 * Two rules make it usable. Parsing is pure — `(lines) => Transcript` — so the
 * whole vendor-specific half is testable against a fixture with no filesystem
 * and no provider; the only I/O here is finding the file and reading it. And
 * parsing is total: a line that is malformed, truncated mid-write, or of a kind
 * a vendor added last week is skipped rather than failing the read, because a
 * partially-readable transcript is the normal state of a run that crashed and
 * the exact case the reader was written for.
 *
 * Nothing here clips. {@link TranscriptEntry.text} is what the provider wrote,
 * at full length, because the reader cannot know whether its caller is filling
 * a run event with a text budget or writing the whole thing to an artifact. The
 * one deliberate exception is reasoning, which is measured and never quoted.
 *
 * The text of a tool call is the provider's raw arguments, which is a `git` or
 * `gh` command line and therefore a credential. A caller putting one on a
 * durable event summarizes or sanitizes it first; the reader's job is fidelity
 * to the file.
 *
 * The economics come out of the same read, as {@link TranscriptUsage} — one
 * reading per model request, beside the conversation rather than inside it.
 * Both vendors write their token counts into these files and nothing else in
 * the system was reading them, which left "how full is this session's context
 * window" answerable only by opening the file by hand.
 */

import { basename, join } from "node:path";
import { SessionProvider } from "@workspace/domain";
import { Effect, Option, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { TRANSCRIPT_GLOB, transcriptDirOf } from "./paths";
import { parseClaudeTranscript } from "./transcript-claude";
import { parseCodexTranscript } from "./transcript-codex";

/**
 * What produced one line of the conversation. Deliberately not the providers'
 * own role vocabulary: both of them fold tool traffic into the user and
 * assistant roles, and a reader that has to open `content` to find out whether
 * a "user" turn is a person or a tool result has no useful role at all.
 *
 * `system` is everything injected rather than said — the developer prompt,
 * environment context, a hook's output. It is kept because "what was this model
 * actually told" is the first question a bad run raises.
 */
export const TRANSCRIPT_ROLES = [
  "assistant",
  "reasoning",
  "system",
  "tool_call",
  "tool_result",
  "user",
] as const;

/** Who or what produced a transcript entry. */
export const TranscriptRole = Schema.Literals(TRANSCRIPT_ROLES);
export type TranscriptRole = typeof TranscriptRole.Type;

/**
 * One thing that happened in a conversation, as the provider recorded it.
 *
 * `chars` measures what the provider produced and `text` is what is kept, so
 * the two agree everywhere except on reasoning, where the count is the size of
 * the model's thinking and the text is empty. That is the whole reason the
 * count is a field rather than something a reader derives from `text.length`:
 * a measured-but-not-carried entry has to stay countable.
 */
export const TranscriptEntry = Schema.Struct({
  /** Pairs a call to its result. Null on everything that is not tool traffic. */
  callId: Schema.NullOr(Schema.String),
  /** Length of what the provider produced, which is `text.length` except on reasoning. */
  chars: Schema.Natural,
  /** The 0-based line of the file this came from. Several entries share a line when one message held several blocks. */
  line: Schema.Natural,
  /** The provider's own stamp, verbatim, or null on the lines that carry none. Decoding it is the caller's, along with its own fallback clock. */
  occurredAt: Schema.NullOr(Schema.String),
  /** Whether a tool succeeded. Null where the provider does not say, which is not the same as false. */
  ok: Schema.NullOr(Schema.Boolean),
  role: TranscriptRole,
  /** Unclipped. The caller owns the budget, and only it knows which one applies. */
  text: Schema.String,
  /** Null on everything that is not tool traffic. */
  toolName: Schema.NullOr(Schema.String),
});

export interface TranscriptEntry
  extends Schema.Schema.Type<typeof TranscriptEntry> {}

/**
 * What one model request cost, as the provider recorded it.
 *
 * A parallel stream rather than a field on {@link TranscriptEntry}, because the
 * two do not line up: one Claude line explodes into a thinking block, some
 * prose and four tool calls — six entries against one usage reading — and
 * repeating the reading on each of them is a number that gets summed six times
 * by the first person who tries. A request is its own thing and is counted as
 * one.
 *
 * Every field is nullable and none is invented. The providers report different
 * halves of the same picture, and a zero standing in for a figure a provider
 * never wrote is the one mistake that makes the whole record untrustworthy.
 * What is normalized is meaning, never presence: {@link TranscriptUsage.input}
 * is *fresh* prompt tokens on both providers, because Codex's own
 * `input_tokens` includes what it read from cache and Claude's does not, and
 * adding those two together as if they were the same quantity is a total that
 * counts a large cache twice.
 */
export const TranscriptUsage = Schema.Struct({
  /** A cache hit's tokens. */
  cacheRead: Schema.NullOr(Schema.Natural),
  /** Tokens written into the prompt cache, however long they live. */
  cacheWrite: Schema.NullOr(Schema.Natural),
  /**
   * The part of {@link TranscriptUsage.cacheWrite} written for an hour, which
   * Claude bills at twice input against 1.25x for five minutes. Null where the
   * provider does not split the total, and the summary then prices the whole
   * write at the cheaper rate — which makes the estimate a floor, not a guess.
   */
  cacheWrite1h: Schema.NullOr(Schema.Natural),
  /** The five-minute part of the same total. */
  cacheWrite5m: Schema.NullOr(Schema.Natural),
  /**
   * The window this request occupied: fresh input plus cache reads plus cache
   * writes. The one figure the growth curve is drawn from, and the only field
   * here that is not nullable — a reading that could not produce it is not a
   * reading and is dropped.
   */
  context: Schema.Natural,
  /**
   * The provider's own context window for this request. Codex writes it into
   * every `token_count`; Claude writes nothing of the kind, and a null here is
   * what sends the summary to the model-id lookup.
   */
  contextWindow: Schema.NullOr(Schema.Natural),
  /** Fresh prompt tokens: what neither cache covered. */
  input: Schema.NullOr(Schema.Natural),
  /** The 0-based line of the file this reading came from. */
  line: Schema.Natural,
  /** What actually answered, which is not always what was asked for. */
  model: Schema.NullOr(Schema.String),
  /** The provider's own stamp, verbatim, or null on the lines that carry none. */
  occurredAt: Schema.NullOr(Schema.String),
  output: Schema.NullOr(Schema.Natural),
  /** The thinking half of output, where the provider separates it. Claude does not. */
  reasoningOutput: Schema.NullOr(Schema.Natural),
  /**
   * The speed tier the request ran at, where the provider names one. Claude
   * writes `standard` or `fast` on every usage block, and fast mode is twice
   * the price — so this is the difference between a cost estimate and a wrong
   * one.
   */
  speed: Schema.NullOr(Schema.String),
});

export interface TranscriptUsage
  extends Schema.Schema.Type<typeof TranscriptUsage> {}

/** One parsed transcript file: the conversation, what it spent, and whose it was. */
export interface Transcript {
  /** In file order, which is the order things happened. */
  readonly entries: readonly TranscriptEntry[];
  /** The provider's own session id, as the file names or declares it. Null when the file never said. */
  readonly providerSessionId: string | null;
  /** One reading per model request, in file order. Empty where the provider recorded none. */
  readonly usage: readonly TranscriptUsage[];
}

/** A file that parsed to nothing, and the value a parser starts from. */
export const EMPTY_TRANSCRIPT: Transcript = {
  entries: [],
  providerSessionId: null,
  usage: [],
};

/**
 * The lines of a JSONL file, blank ones dropped. Split rather than streamed
 * because a transcript is a few megabytes at worst and the parser is pure over
 * the whole array.
 */
export const splitLines = (content: string): readonly string[] =>
  content.split("\n").filter((line) => line.trim().length > 0);

/**
 * Total characters the conversation produced, reasoning included. The one
 * number a wide event wants from a transcript: content is measured, never
 * carried, and this is the measurement.
 */
export const transcriptChars = (entries: readonly TranscriptEntry[]) =>
  entries.reduce((total, entry) => total + entry.chars, 0);

/**
 * Which parser reads which vendor's file. A mapped record rather than a switch,
 * so a third provider is a build error here rather than a silently empty
 * transcript at runtime.
 */
const PARSERS = {
  claude: parseClaudeTranscript,
  codex: parseCodexTranscript,
} as const satisfies Record<
  SessionProvider,
  (lines: readonly string[]) => Transcript
>;

/** Parses one provider's transcript lines. Pure, and total over malformed input. */
export const parseTranscript = (
  provider: SessionProvider,
  lines: readonly string[]
) => PARSERS[provider](lines);

/**
 * Nothing under the provider's transcript directory carried this session id.
 * Its own error rather than an empty transcript, because "the agent said
 * nothing" and "the provider never wrote a file" are different failures and
 * only the second one means the agent home was wired up wrong.
 */
export class TranscriptNotFound extends Schema.TaggedErrorClass<TranscriptNotFound>()(
  "Harness.TranscriptNotFound",
  {
    provider: SessionProvider,
    /** The id the scan narrowed to. */
    providerSessionId: Schema.String,
    /** Where the scan looked, so the message names a path a human can `ls`. */
    searchDir: Schema.String,
  }
) {}

/** The file was there and could not be read: permissions, a vanished mount, a partial unmount. */
export class TranscriptUnreadable extends Schema.TaggedErrorClass<TranscriptUnreadable>()(
  "Harness.TranscriptUnreadable",
  { cause: Schema.Unknown, path: Schema.String }
) {}

/** Everything reading a transcript can fail with. */
export type TranscriptError = TranscriptNotFound | TranscriptUnreadable;

/** Which session's transcript to look for, and where the provider writes them. */
export interface FindTranscriptInput {
  /** The provider's config directory, which is shared by every run on the host. */
  readonly agentHomeDir: string;
  readonly provider: SessionProvider;
  /**
   * Narrows the scan to the file whose name carries this id, which works for
   * both vendors: Claude names the file after the session, Codex embeds the
   * session in the rollout name.
   *
   * Required, and that is the whole safety property of this reader. Every run
   * and every conversation on the host writes into the one shared tree, so a
   * scan that fell back to the newest file by mtime would hand this run a
   * neighbour's conversation — silently, and onward into the durable per-run
   * copy the ingest reads. A run that ended before naming a session has no
   * transcript, which is the honest answer.
   */
  readonly providerSessionId: string;
}

/** A candidate file and the clock that ranks it. */
interface Candidate {
  readonly modifiedAt: number;
  readonly path: string;
}

/** Files under the directory, or none at all when the directory never existed. */
const scan = Effect.fnUntraced(function* (
  directory: string,
  provider: SessionProvider
) {
  const fs = yield* FileSystem;
  return yield* fs
    .glob(TRANSCRIPT_GLOB[provider], { root: directory })
    .pipe(Effect.orElseSucceed((): readonly string[] => []));
});

/**
 * Ranks a candidate by mtime. A file whose stat fails is dropped rather than
 * ranked at epoch zero — it would otherwise sort last and silently win a
 * single-candidate scan.
 */
const stamp = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem;
  const info = yield* Effect.option(fs.stat(path));
  if (Option.isNone(info)) {
    return null;
  }
  const modified = info.value.mtime;
  return Option.isNone(modified)
    ? null
    : ({ modifiedAt: modified.value.getTime(), path } satisfies Candidate);
});

/**
 * The transcript file this run wrote. Scans rather than composing a filename:
 * the directory nesting and the naming inside it belong to the vendors, and a
 * reader that scans keeps working when one of them changes either.
 */
export const findTranscript = Effect.fn("Transcript.find")(function* (
  input: FindTranscriptInput
) {
  const directory = transcriptDirOf(input.agentHomeDir, input.provider);
  const relative = yield* scan(directory, input.provider);
  const wanted = input.providerSessionId;
  const matched = relative.filter((path) => basename(path).includes(wanted));

  const candidates = yield* Effect.forEach(matched, (path) =>
    stamp(join(directory, path))
  );
  const newest = candidates
    .filter((candidate): candidate is Candidate => candidate !== null)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .at(0);

  if (newest === undefined) {
    return yield* Effect.fail(
      new TranscriptNotFound({
        provider: input.provider,
        providerSessionId: input.providerSessionId,
        searchDir: directory,
      })
    );
  }
  return newest.path;
});

/** A parsed transcript and the file it came from. */
export interface TranscriptFile extends Transcript {
  readonly path: string;
}

/** Reads and parses one file whose path is already known. */
export const readTranscriptAt = Effect.fn("Transcript.readAt")(function* (
  path: string,
  provider: SessionProvider
) {
  const fs = yield* FileSystem;
  const content = yield* fs
    .readFileString(path)
    .pipe(
      Effect.mapError((cause) => new TranscriptUnreadable({ cause, path }))
    );
  const parsed = parseTranscript(provider, splitLines(content));
  return { ...parsed, path } satisfies TranscriptFile;
});

/**
 * Finds one session's transcript and parses it. The whole reader in one call,
 * for the ingest — which has an agent home and a session id and wants records.
 */
export const readTranscript = Effect.fn("Transcript.read")(function* (
  input: FindTranscriptInput
) {
  const path = yield* findTranscript(input);
  return yield* readTranscriptAt(path, input.provider);
});
