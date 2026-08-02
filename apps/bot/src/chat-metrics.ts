/**
 * The bounded projection of `atm.chat`: two series-safe instruments, and the
 * `const` vocabularies both the row and the tags are drawn from.
 *
 * The split from `./chat-event` is the cardinality boundary. Everything that
 * makes a row worth querying — the chat, the Telegram account, the thread, the
 * task, the workspace — is unbounded and belongs on the event only; everything
 * here comes from a tuple that can be written down, so the number of time
 * series is a property of the contract rather than of how many people use the
 * bot. `boundedCounter` makes that a compile error rather than a convention:
 * `chatId` and `userId` cannot be tag names at all.
 *
 * The vocabularies live here, below the event, because the event records its
 * own counters as it emits and a tuple defined the other way round would be a
 * cycle between the two modules.
 */

import { SESSION_PROVIDERS } from "@workspace/domain";
import {
  BASE_OUTCOMES,
  boundedCounter,
  boundedHistogram,
} from "@workspace/telemetry";
import { Effect, Metric } from "effect";

/**
 * What one update turned out to be. `notify` is the outbound half — a message
 * the bot volunteered — and it shares the tuple because the question asked of
 * this counter is "what does this bot spend its time on", which has both halves
 * in it.
 */
export const CHAT_UPDATE_KINDS = [
  "text",
  "voice",
  "forward",
  "command",
  "callback",
  "notify",
] as const;

/** What kind of work one `atm.chat` row describes. */
export type ChatUpdateKind = (typeof CHAT_UPDATE_KINDS)[number];

/**
 * The endings the base union cannot express. A sender who is not on the
 * allow-list was turned away rather than failed; an update the bot declined to
 * act on — an expired button, a photo — was answered rather than crashed; and a
 * message that arrived while its conversation was mid-turn was stored and left
 * for the next one. Folding any of them into `errored` is how a misconfigured
 * allow-list becomes indistinguishable from a broken handler.
 *
 * `done` is the ordinary ending, and on an inbound message it means the bot
 * accepted it — not that a turn finished. A turn is an `atm.run` row and counts
 * itself.
 */
export const CHAT_EXTRA_OUTCOMES = [
  "not_allowed",
  "queued",
  "rejected",
] as const;

/**
 * Every ending an update can have, in one tuple: the base four plus this unit's
 * two. Derived from the same halves `outcomeField` composes, so the tag
 * vocabulary and the row's literals cannot drift apart.
 */
export const CHAT_OUTCOMES = [
  ...BASE_OUTCOMES,
  ...CHAT_EXTRA_OUTCOMES,
] as const;

/** How one update ended, as the ledger and the counters spell it. */
export type ChatOutcome = (typeof CHAT_OUTCOMES)[number];

/**
 * Updates handled. The ceiling is six kinds times seven endings times three
 * provider values, and it cannot grow without one of those tuples growing.
 */
const chatUpdatesTotal = boundedCounter("atm_chat_updates_total", {
  description: "Telegram updates handled, by kind, ending and provider",
  tags: {
    kind: CHAT_UPDATE_KINDS,
    outcome: CHAT_OUTCOMES,
    provider: SESSION_PROVIDERS,
  },
});

/**
 * A turn is seconds to minutes — a voice note is transcribed before the
 * manager sees it, and the manager's own cap is five minutes — so the buckets
 * start at 50ms and reach past seven minutes.
 */
const DURATION_MS_BOUNDARIES = Metric.exponentialBoundaries({
  count: 14,
  factor: 2,
  start: 50,
});

/**
 * Update received to row written. The ending is deliberately not a tag: a
 * histogram is buckets times series, and the question latency answers is "which
 * kind of update is slow", not "how fast are the refusals" — which the counter
 * already answers.
 */
const chatTurnDurationMs = boundedHistogram("atm_chat_turn_duration_ms", {
  boundaries: DURATION_MS_BOUNDARIES,
  description: "Update received to row written, per update kind",
  tags: { kind: CHAT_UPDATE_KINDS, provider: SESSION_PROVIDERS },
});

/** The bounded half of one finished update. */
export interface ChatMeasurement {
  readonly durationMs: number;
  readonly kind: ChatUpdateKind;
  readonly outcome: ChatOutcome;
  /** Null on every update that never reached a provider, which is most of them. */
  readonly provider: (typeof SESSION_PROVIDERS)[number] | null;
}

/**
 * Counts the update from the same ending the row reports, so the counters and
 * the ledger cannot disagree. Swallows its own failures, tag derivation
 * included: a metric may never mask the work it describes.
 */
export const recordChatMetrics = (measurement: ChatMeasurement) =>
  Effect.gen(function* () {
    const { durationMs, kind, outcome, provider } = measurement;
    yield* chatUpdatesTotal.increment({ kind, outcome, provider });
    yield* chatTurnDurationMs.record({ kind, provider }, durationMs);
  }).pipe(Effect.ignoreCause);
