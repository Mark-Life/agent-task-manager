/**
 * Whether a provider has allowance left, and what to do when it does not.
 *
 * The gate sits in front of dispatch and answers one question per run: admit, or
 * hold this provider back. Two signals feed it, layered on purpose.
 *
 * **Proactive** is a cached read of the provider's own rolling windows — free,
 * passive, one HTTP GET per poll interval — and it defers *before* a run is
 * spent. It is the primary gate and the only one that knows when the window
 * actually rolls over.
 *
 * **Reactive** is the floor under it: a run that already failed with a drained
 * signal trips a cooldown pause. That covers the proactive read being switched
 * off, the endpoint moving, and the window filling between two polls.
 *
 * The split that decides everything here is *unreadable* against *drained*. A
 * signal we could not read — no credentials, a 401, a body whose shape changed —
 * fails **open**: dispatch proceeds and an alert fires, because a gate that
 * silently disables itself is worse than no gate. A signal we did read and that
 * says the provider is out fails **safe**: dispatch defers. Getting those the
 * wrong way round either burns a subscription against a wall or idles a healthy
 * pool with nobody watching.
 *
 * A pause is per provider. A drained Claude does not hold back a Codex run —
 * separate cache, separate pause record — which is most of the value of running
 * two harnesses.
 *
 * Two things are files rather than memory. The pause record, so a loop
 * restarting inside a drain does not immediately re-probe with a burst of runs.
 * And the last good reading per provider — see `./readings` — so a restart, or a
 * poll that stops working, leaves the panel showing dated figures rather than
 * "no signal". Neither is consulted for a decision: what gates a dispatch is the
 * live pause and the latest attempt, both of which re-derive from live signals.
 *
 * The cooldown is always the conservative one, never a reset the signal carried.
 * Both reactive sources report their reset best-effort and frequently omit it,
 * so honouring one would resume dispatch into a wall; the proactive read owns
 * the exact reset and resumes a still-drained provider precisely.
 */

import { join } from "node:path";
import { QUOTA_SEGMENT, type SessionProvider } from "@workspace/domain";
import type { RateLimitStatus } from "@workspace/harness";
import { Clock, Context, Effect, Layer, Ref, Semaphore } from "effect";
import { FileSystem } from "effect/FileSystem";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { orchestratorConfig } from "../config";
import { QuotaPaused } from "../errors";
import { fetchClaudeUsage } from "./claude-usage";
import { fetchCodexUsage } from "./codex-usage";
import { type QuotaConfig, quotaConfig } from "./config";
import {
  detectRateLimitStatus,
  detectUsageLimitText,
  looksRateLimitShaped,
} from "./detect";
import {
  quotaCanary,
  quotaReactivePauses,
  quotaReadFailures,
  quotaUtilization,
} from "./metrics";
import {
  readStoredReadings,
  storedReadingOf,
  writeStoredReadings,
} from "./readings";
import { type ProviderReading, publishUsage, usageSnapshot } from "./snapshot";
import {
  ADMIT,
  type ProviderUsage,
  type QuotaDecision,
  type QuotaDeferred,
  type QuotaWindow,
  UNAVAILABLE_USAGE,
  type WindowUsage,
} from "./types";

/** The persisted pause record, one entry per paused provider. */
const PAUSE_FILE = "pause.json";

/**
 * The ceiling on the doubling cooldown. A provider that keeps re-tripping
 * settles at one probe a day rather than at never — the drain does end, and a
 * gate that stopped probing would need a human to notice it had.
 */
const MAX_COOLDOWN_MS = 86_400_000;

/** How much of an unmatched error the canary log line quotes. */
const CANARY_MESSAGE_CHARS = 120;

/** What is written down about a paused provider, and read back after a restart. */
interface PauseRecord {
  readonly reason: string;
  /** Consecutive re-trips, which is what makes the cooldown double. */
  readonly trips: number;
  /** Unix milliseconds before which this provider's new dispatch stays deferred. */
  readonly until: number;
  readonly window: QuotaWindow;
}

/** The pause file's contents: provider to record, absent meaning not paused. */
type PauseMap = Record<string, PauseRecord>;

/**
 * A pause record only while it is still holding. An expired one is a record of
 * a drain that ended, and reading it as live would idle a provider that has
 * already come back.
 */
const inForce = (record: PauseRecord | null, nowMs: number) =>
  record !== null && nowMs < record.until ? record : null;

/** A live read of one provider's allowance. Always succeeds — see the readers. */
export type UsageReader = () => Effect.Effect<ProviderUsage>;

/** One read, with the moment it was taken. */
interface CachedUsage {
  readonly atMs: number;
  readonly usage: ProviderUsage;
}

/**
 * Everything the gate keeps per provider. Isolated, so one drain gates one
 * provider.
 *
 * Two reads are remembered and they answer different questions. `attempt` is the
 * last look, whatever it produced, and it is what a decision is made on and what
 * the poll interval is measured from — an unreadable provider has to keep
 * dispatching and must not be re-probed once per task. `reading` is the last
 * look that carried a signal, it never goes backwards, and it is what gets
 * published; it is also the only one written to disk, in `./readings`.
 */
interface ProviderState {
  /** Tasks already told about the current pause episode, so the loud surface says it once. */
  readonly announced: Ref.Ref<ReadonlySet<string>>;
  /** The last attempt and what it said. Null before the first one. */
  readonly attempt: Ref.Ref<CachedUsage | null>;
  /** Present only where the provider says it in prose rather than in a field. */
  readonly detectText: ((message: string) => boolean) | null;
  /** The last attempt that carried a signal. Null until one does. */
  readonly reading: Ref.Ref<CachedUsage | null>;
  readonly readUsage: UsageReader;
}

/** What building a gate needs: the settings, where to write, and any test readers. */
export interface QuotaGateOptions extends QuotaConfig {
  /**
   * Where each provider's login lives on the host. The same directory the
   * containers are handed, because the allowance worth reading is the one the
   * runs spend — not whatever the operator's own CLI is logged into.
   */
  readonly agentHomeDirs: Readonly<Record<SessionProvider, string>>;
  /** Per-provider reader override. Injected by tests; nothing else sets it. */
  readonly readers?: Readonly<Partial<Record<SessionProvider, UsageReader>>>;
  readonly stateDir: string;
}

/** Which provider a question is about, and how many of its runs are already up. */
export interface QuotaRequest {
  /** In-flight runs on this provider, which is what the headroom is reserved against. */
  readonly inflight: number;
  readonly provider: SessionProvider;
}

/** A deferral the gate is being told was acted on. */
export interface DeferredNotice {
  readonly decision: QuotaDeferred;
  readonly provider: SessionProvider;
}

/** A run's error text, offered to the reactive floor. */
export interface ErrorNotice {
  /** Already clipped and sanitized by the time it reaches here. */
  readonly message: string;
  readonly provider: SessionProvider;
}

/** A harness rate-limit reading, offered to the reactive floor. */
export interface RateLimitNotice {
  readonly provider: SessionProvider;
  readonly status: RateLimitStatus | null;
}

/**
 * One piece of work asking whether it has already been told about this pause.
 * Keyed by `./subject`'s subject key rather than by a task id, because a chat
 * turn is deferred by the same drained subscription and has no task to name.
 */
export interface AnnounceRequest {
  readonly provider: SessionProvider;
  readonly subjectKey: string;
}

/**
 * The typed failure a deferral becomes where dispatch has to fail rather than
 * skip. Built here because the gate is the only thing that knows both the window
 * and the reset, and the seam's error carries them onto the run's row.
 */
export const quotaPausedError = (notice: DeferredNotice) =>
  new QuotaPaused({
    detail: notice.decision.reason,
    provider: notice.provider,
    resumesAtMs: notice.decision.resumesAtMs,
  });

const makeGate = (options: QuotaGateOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const http = yield* HttpClient.HttpClient;
    const pausePath = join(options.stateDir, PAUSE_FILE);

    // One file holds every provider's record, so two providers tripping at once
    // would otherwise read-modify-write over each other and lose one.
    const pauseLock = yield* Semaphore.make(1);

    /**
     * The reader for a provider: a test's, the real one, or none at all.
     *
     * Keyed on `read` rather than on `proactive`, which is the whole of the
     * observe-only state: the numbers are polled and published for a person to
     * look at, and whether they may hold a dispatch back is decided later, in
     * {@link evaluate}.
     */
    const readerFor = (provider: SessionProvider): UsageReader => {
      const injected = options.readers?.[provider];
      if (injected !== undefined) {
        return injected;
      }
      if (!options.read) {
        return () => Effect.succeed(UNAVAILABLE_USAGE);
      }
      const agentHomeDir = options.agentHomeDirs[provider];
      switch (provider) {
        case "codex":
          return () => fetchCodexUsage({ agentHomeDir, fs, http });
        case "claude":
          return () => fetchClaudeUsage({ agentHomeDir, fs, http });
        default:
          // Pi has no allowance endpoint — see `HAS_ALLOWANCE` in `./config`,
          // which keeps it out of `GATED_PROVIDERS` so this arm is unreachable
          // in production. It is here because `readerFor` is total over the
          // union, and because reading a Claude credential out of Pi's home is
          // what a fall-through would have done.
          return () => Effect.succeed(UNAVAILABLE_USAGE);
      }
    };

    // The good readings from before this process existed. Loaded once, here,
    // rather than on demand: a panel that showed nothing until the first sweep
    // completed would blank the board on every restart, which is the failure
    // this store exists to end.
    const stored = yield* readStoredReadings({
      fs,
      stateDir: options.stateDir,
    });

    const states = new Map<SessionProvider, ProviderState>();
    for (const provider of options.providers) {
      states.set(provider, {
        announced: yield* Ref.make<ReadonlySet<string>>(new Set()),
        // Deliberately not seeded from the store. A reading restored from disk
        // is old by definition, and seeding the attempt cache with it would
        // both suppress the first poll and let a stale drain hold a dispatch
        // back — see the note at the top of `./readings`.
        attempt: yield* Ref.make<CachedUsage | null>(null),
        // Only Codex gets the prose matcher, on the grounds that Claude's
        // reading arrives as a field on the usage event and goes through
        // `noteRateLimit` instead.
        //
        // That second half is not true today: `noteRateLimit` is called from
        // nowhere but this package's tests, so Claude currently has no reactive
        // floor at all. Wiring it is the first recommendation in
        // `.docs/provider-usage-sources.md`; adding the text matcher here is
        // not the fix, because the structured field is the better signal and it
        // is already being carried out of every run.
        detectText: provider === "codex" ? detectUsageLimitText : null,
        reading: yield* Ref.make<CachedUsage | null>(
          storedReadingOf(stored, provider)
        ),
        readUsage: readerFor(provider),
      });
    }

    /**
     * Writes every provider's last good reading down, so the next process
     * starts with the figures this one has rather than with a blank panel.
     *
     * Whole-map on each advance rather than a merge, because this process owns
     * the file for its lifetime and the alternative — read, merge, write — is a
     * race between two providers refreshing in the same sweep for no gain.
     */
    const persistReadings = Effect.gen(function* () {
      const readings: Record<string, CachedUsage> = {};
      for (const [provider, state] of states) {
        const reading = yield* Ref.get(state.reading);
        if (reading !== null) {
          readings[provider] = reading;
        }
      }
      yield* writeStoredReadings({ fs, readings, stateDir: options.stateDir });
    });

    /** The governed state for a provider, or null when the gate is off. */
    const stateOf = (provider: SessionProvider) =>
      options.enabled ? (states.get(provider) ?? null) : null;

    /** The pause file, or an empty map on anything at all. */
    const readPauses = fs.readFileString(pausePath).pipe(
      Effect.map((text) => JSON.parse(text) as PauseMap),
      Effect.catchCause(() => Effect.succeed({} as PauseMap))
    );

    /**
     * Writes the map through a temporary file, so a crash mid-write leaves the
     * previous record rather than a truncated one that reads as "not paused".
     */
    const writePauses = (map: PauseMap) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(options.stateDir, { recursive: true });
        const temporary = `${pausePath}.${process.pid}.tmp`;
        yield* fs.writeFileString(temporary, JSON.stringify(map, null, 2));
        yield* fs.rename(temporary, pausePath);
      }).pipe(Effect.ignoreCause);

    /** One provider's record, expired or not. */
    const pauseOf = (provider: SessionProvider) =>
      readPauses.pipe(Effect.map((map) => map[provider] ?? null));

    /** The record only while it is still in force. */
    const activePause = (provider: SessionProvider, nowMs: number) =>
      pauseOf(provider).pipe(Effect.map((record) => inForce(record, nowMs)));

    /**
     * One provider as the document describes it: the figures it last gave, the
     * moment it last gave them, the moment anyone last looked, and the pause
     * over the top.
     *
     * The two reads come from the two Refs and are deliberately not merged. A
     * failed poll moves the attempt and leaves the figures, which is what
     * stale-dates them instead of erasing them.
     */
    const readingOf = (input: {
      readonly pause: PauseRecord | null;
      readonly provider: SessionProvider;
      readonly state: ProviderState;
    }) =>
      Effect.gen(function* () {
        const good = yield* Ref.get(input.state.reading);
        const attempt = yield* Ref.get(input.state.attempt);
        return {
          attemptCarriedSignal: attempt?.usage.available ?? false,
          attemptedAtMs: attempt?.atMs ?? null,
          enforced: options.enabled && options.proactive,
          pausedUntilMs: input.pause === null ? null : input.pause.until,
          pauseReason: input.pause === null ? null : input.pause.reason,
          provider: input.provider,
          readAtMs: good?.atMs ?? null,
          reading: options.enabled && options.read,
          usage: good?.usage ?? UNAVAILABLE_USAGE,
        } satisfies ProviderReading;
      });

    /**
     * Everything the gate currently believes, as the published document.
     *
     * Off the caches and the pause file, never off a live read: this is called
     * after a refresh and after a pause changes, and a read here would put an
     * HTTP request behind a write nobody asked for.
     */
    const currentSnapshot = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const pauses = yield* readPauses;
      const readings: ProviderReading[] = [];
      // Over the states rather than over `options.providers`: the map was built
      // from that list, so every entry has one and nothing has to be defended
      // against a provider that is not there.
      for (const [provider, state] of states) {
        readings.push(
          yield* readingOf({
            pause: inForce(pauses[provider] ?? null, nowMs),
            provider,
            state,
          })
        );
      }
      return usageSnapshot({ nowMs, readings });
    });

    /** Leaves the current reading where the gateway serves it from. */
    const publish = Effect.gen(function* () {
      const snapshot = yield* currentSnapshot;
      yield* publishUsage({ fs, snapshot, stateDir: options.stateDir });
    });

    const setPause = (provider: SessionProvider, record: PauseRecord) =>
      Semaphore.withPermit(pauseLock)(
        Effect.gen(function* () {
          const map = yield* readPauses;
          yield* writePauses({ ...map, [provider]: record });
        })
      );

    /** Ends the pause episode, including the per-task announcements it carried. */
    const clearPause = (provider: SessionProvider) =>
      Effect.gen(function* () {
        yield* Semaphore.withPermit(pauseLock)(
          Effect.gen(function* () {
            const map = yield* readPauses;
            if (map[provider] === undefined) {
              return;
            }
            const { [provider]: _cleared, ...rest } = map;
            yield* writePauses(rest);
          })
        );
        const state = states.get(provider);
        if (state !== undefined) {
          yield* Ref.set(state.announced, new Set<string>());
        }
        yield* publish;
      });

    const recordUtilization = (
      provider: SessionProvider,
      usage: ProviderUsage
    ) =>
      Effect.gen(function* () {
        if (usage.primary !== null) {
          yield* quotaUtilization.record(
            { provider, window: "primary" },
            usage.primary.utilizationPercent
          );
        }
        if (usage.secondary !== null) {
          yield* quotaUtilization.record(
            { provider, window: "secondary" },
            usage.secondary.utilizationPercent
          );
        }
      }).pipe(Effect.ignoreCause);

    /**
     * The cached read, refreshing at most once per poll interval. The alert on
     * an unavailable read fires here rather than per task, because the cache is
     * what keeps it to one line per interval — and it distinguishes the switch
     * being off from the read having failed, since only one of those is a fault.
     *
     * What this answers is always the last *attempt*, including an unreadable
     * one. The gate fails open on those, and handing it the last good reading
     * instead would turn a stale drain into a pool held shut for as long as the
     * read stays broken. The good reading is kept beside it, for the panel.
     */
    const cachedUsage = (
      provider: SessionProvider,
      state: ProviderState,
      nowMs: number
    ) =>
      Effect.gen(function* () {
        const cached = yield* Ref.get(state.attempt);
        if (cached !== null && nowMs - cached.atMs < options.pollIntervalMs) {
          return cached.usage;
        }
        const usage = yield* state.readUsage();
        yield* Ref.set(state.attempt, { atMs: nowMs, usage });
        yield* recordUtilization(provider, usage);
        if (usage.available) {
          yield* Ref.set(state.reading, { atMs: nowMs, usage });
          yield* persistReadings;
          return usage;
        }
        yield* quotaReadFailures
          .increment({
            provider,
            reason: options.read ? "unavailable" : "off",
          })
          .pipe(Effect.ignoreCause);
        if (options.read) {
          yield* Effect.logWarning(
            `quota: ${provider} usage read produced no signal — dispatching anyway`
          );
        }
        return usage;
      });

    /**
     * Take the reading and publish it, on whatever cadence the caller sweeps.
     *
     * This is what keeps the published numbers honest on an idle board. Without
     * it the only thing that ever polls is a dispatch, so a factory with nothing
     * to do would show the allowance it had when it last had work — which is
     * precisely when somebody is looking to decide whether to give it more.
     *
     * Cheap to call often: the cache decides whether a poll actually happens, so
     * a 30-second sweep against a five-minute interval is one HTTP GET per
     * provider per five minutes and a small file write per sweep.
     */
    const refresh = Effect.fn("QuotaGate.refresh")(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      for (const provider of options.providers) {
        const state = stateOf(provider);
        if (state === null) {
          continue;
        }
        // A paused provider is not polled: the pause is a confirmed drain, and
        // the cooldown is what decides when to look again.
        const pause = yield* activePause(provider, nowMs);
        if (pause === null) {
          yield* cachedUsage(provider, state, nowMs);
        }
      }
      yield* publish;
    });

    const defer = (
      window: QuotaWindow,
      reason: string,
      resumesAtMs: number | null
    ): QuotaDecision => ({
      defer: true,
      // The long window is the loud one: days of idle is worth saying on the
      // task, while the short window rolls over inside a working session.
      loud: window === "secondary",
      reason,
      resumesAtMs,
      window,
    });

    /** Defers when a window plus the in-flight headroom reaches the threshold. */
    const windowDecision = (
      window: "primary" | "secondary",
      usage: WindowUsage | null,
      inflight: number
    ): QuotaDecision | null => {
      if (usage === null) {
        return null;
      }
      const effective =
        usage.utilizationPercent + inflight * options.headroomPercent;
      if (effective < options.thresholdPercent) {
        return null;
      }
      const label = window === "primary" ? "5h" : "weekly";
      return defer(
        window,
        `${label} window at ${usage.utilizationPercent}% with ${inflight} in flight (threshold ${options.thresholdPercent}%)`,
        usage.resetsAtMs
      );
    };

    /** The provider's own "I am out", pointed at the window it named. */
    const limitReachedDecision = (usage: ProviderUsage): QuotaDecision => {
      const window = usage.reachedWindow ?? "primary";
      const resumesAtMs =
        window === "secondary"
          ? (usage.secondary?.resetsAtMs ?? null)
          : (usage.primary?.resetsAtMs ?? null);
      return defer(
        window,
        "the provider reports its limit reached",
        resumesAtMs
      );
    };

    /**
     * The decision, given everything already resolved. Side-effect free, and the
     * order is the policy: a live reactive pause wins because it is a confirmed
     * drain, an unenforced reading is published rather than acted on, an
     * unreadable signal then fails open, a stated limit beats a threshold, and
     * the short window is checked before the long one so the shorter wait is the
     * one reported.
     *
     * The reactive pause is checked before the enforcement switch on purpose: it
     * is a drain a run already paid for, and it holds whatever the proactive
     * read is or is not allowed to do.
     */
    const evaluate = (input: {
      readonly inflight: number;
      readonly pause: PauseRecord | null;
      readonly usage: ProviderUsage;
    }): QuotaDecision => {
      if (input.pause !== null) {
        return defer(input.pause.window, input.pause.reason, input.pause.until);
      }
      if (!(options.proactive && input.usage.available)) {
        return ADMIT;
      }
      if (input.usage.limitReached) {
        return limitReachedDecision(input.usage);
      }
      return (
        windowDecision("primary", input.usage.primary, input.inflight) ??
        windowDecision("secondary", input.usage.secondary, input.inflight) ??
        ADMIT
      );
    };

    /**
     * Whether this trip continues the previous ladder or starts a new one.
     *
     * Consecutive means "the drain never really ended": a run that failed while
     * the pause was still in force, or inside one cooldown of it lifting. A trip
     * long after the last one is a fresh drain and starts at the base cooldown —
     * without which, on a loop with the proactive read switched off, a provider
     * that drains once a week would climb to the day-long ceiling and stay
     * there, since nothing else clears the trip count.
     */
    const tripsFor = (previous: PauseRecord | null, nowMs: number) =>
      previous !== null && nowMs - previous.until < options.cooldownMs
        ? previous.trips + 1
        : 1;

    /**
     * Sets the reactive cooldown, doubling on consecutive re-trips. The length is
     * always the cooldown and never a reset the signal carried — see the note at
     * the top of the file.
     */
    const setReactivePause = (input: {
      readonly provider: SessionProvider;
      readonly reason: string;
    }) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const previous = yield* pauseOf(input.provider);
        const trips = tripsFor(previous, nowMs);
        const cooldown = Math.min(
          options.cooldownMs * 2 ** (trips - 1),
          MAX_COOLDOWN_MS
        );
        const until = nowMs + cooldown;
        yield* setPause(input.provider, {
          reason: input.reason,
          trips,
          until,
          window: "reactive",
        });
        yield* publish;
        yield* quotaReactivePauses
          .increment({ provider: input.provider })
          .pipe(Effect.ignoreCause);
        yield* Effect.logWarning(
          `quota: ${input.provider} paused until ${new Date(until).toISOString()} (trip ${trips})`
        );
      });

    /**
     * The per-dispatch decision. This is the site that triggers the read, so it
     * is the live gate; it mutates nothing but the cache and the metrics, which
     * makes it safe to call from overlapping passes.
     */
    const admit = Effect.fn("QuotaGate.admit")(function* (
      request: QuotaRequest
    ) {
      const state = stateOf(request.provider);
      if (state === null) {
        return ADMIT;
      }
      const nowMs = yield* Clock.currentTimeMillis;
      const pause = yield* activePause(request.provider, nowMs);
      const usage =
        pause === null
          ? yield* cachedUsage(request.provider, state, nowMs)
          : UNAVAILABLE_USAGE;
      const decision = evaluate({
        inflight: request.inflight,
        pause,
        usage,
      });
      if (decision.defer) {
        return decision;
      }
      // A healthy admit ends the episode: the trip count resets, and every task
      // becomes tellable again should the provider drain later.
      if (usage.available && !usage.limitReached && pause === null) {
        const stale = yield* pauseOf(request.provider);
        if (stale !== null) {
          yield* clearPause(request.provider);
        }
      }
      yield* Ref.set(state.announced, new Set<string>());
      return decision;
    });

    /**
     * The same decision off the last read, taking none. What the loop reports
     * with — a pass that already called {@link admit} has the cache warm, so
     * describing a deferral costs nothing.
     */
    const describe = Effect.fn("QuotaGate.describe")(function* (
      request: QuotaRequest
    ) {
      const state = stateOf(request.provider);
      if (state === null) {
        return ADMIT;
      }
      const nowMs = yield* Clock.currentTimeMillis;
      const pause = yield* activePause(request.provider, nowMs);
      const cached = yield* Ref.get(state.attempt);
      return evaluate({
        inflight: request.inflight,
        pause,
        usage:
          pause === null
            ? (cached?.usage ?? UNAVAILABLE_USAGE)
            : UNAVAILABLE_USAGE,
      });
    });

    /**
     * The reactive floor, fed a failed run's error text. A confident match pauses
     * and answers true, which tells the caller the run was a deferral rather than
     * a failed attempt — no retry stamp, no step up the park ladder, because the
     * task did nothing wrong. A shaped-but-unmatched message counts a canary and
     * pauses nothing.
     */
    const noteError = Effect.fn("QuotaGate.noteError")(function* (
      notice: ErrorNotice
    ) {
      const state = stateOf(notice.provider);
      if (state === null || state.detectText === null) {
        return false;
      }
      if (state.detectText(notice.message)) {
        yield* setReactivePause({
          provider: notice.provider,
          reason: "a run failed on a usage limit",
        });
        return true;
      }
      if (looksRateLimitShaped(notice.message)) {
        yield* quotaCanary
          .increment({ provider: notice.provider })
          .pipe(Effect.ignoreCause);
        yield* Effect.logWarning(
          `quota: ${notice.provider} error looked rate-limit-shaped but matched no anchor — the matcher may be stale: ${notice.message.slice(0, CANARY_MESSAGE_CHARS)}`
        );
      }
      return false;
    });

    /**
     * The reactive floor, fed the harness's structured reading. `rejected` is the
     * provider declining to serve and pauses; `allowed_warning` deliberately does
     * not, because it arrives while the remaining allowance is still worth
     * spending.
     */
    const noteRateLimit = Effect.fn("QuotaGate.noteRateLimit")(function* (
      notice: RateLimitNotice
    ) {
      const state = stateOf(notice.provider);
      if (state === null || !detectRateLimitStatus(notice.status)) {
        return false;
      }
      yield* setReactivePause({
        provider: notice.provider,
        reason: "the provider rejected a request on its rate limit",
      });
      return true;
    });

    /**
     * True the first time a subject is offered during the current pause
     * episode, so the loud surface says it once per subject per drain rather
     * than once per pass.
     */
    const announceOnce = (request: AnnounceRequest) => {
      const state = states.get(request.provider);
      if (state === undefined) {
        return Effect.succeed(false);
      }
      return Ref.modify(state.announced, (seen) =>
        seen.has(request.subjectKey)
          ? ([false, seen] as const)
          : ([true, new Set([...seen, request.subjectKey])] as const)
      );
    };

    return {
      admit,
      announceOnce,
      describe,
      noteError,
      noteRateLimit,
      refresh,
      /** The reading as it stands, for a caller in this process. The file is for everyone else. */
      snapshot: currentSnapshot,
    } as const;
  });

/** The gate's method set, derived so a stub cannot drift from the real one. */
export type QuotaGateInterface = Effect.Success<ReturnType<typeof makeGate>>;

/**
 * The per-provider dispatch gate. Provide it once; every dispatch asks it before
 * spending a slot, and the run lifecycle feeds it back whatever the provider
 * said on the way out.
 */
export class QuotaGate extends Context.Service<QuotaGate, QuotaGateInterface>()(
  "@workspace/orchestrator/QuotaGate"
) {
  /**
   * A gate over explicit options. The HTTP client is provided here so the layer
   * is self-contained; a test injecting `readers` never reaches it.
   */
  static readonly layer = (options: QuotaGateOptions) =>
    Layer.effect(QuotaGate, makeGate(options)).pipe(
      Layer.provide(FetchHttpClient.layer)
    );
}

/**
 * The gate as the loop builds it: settings from the environment, and the pause
 * record beside everything else the run leaves on disk. `FileSystem` stays a
 * requirement rather than being pinned here, so the same layer serves the Bun
 * runtime and a test's in-memory one.
 */
export const quotaGateLayer = Layer.effect(
  QuotaGate,
  Effect.gen(function* () {
    const { agentHomeDirs, dataRoot } = yield* orchestratorConfig;
    const config = yield* quotaConfig;
    return yield* makeGate({
      ...config,
      // The loop already resolved where each provider's login lives, because it
      // mounts those directories into every container. One resolution, so the
      // account a run spends and the account this reads cannot be two accounts.
      agentHomeDirs,
      stateDir: join(dataRoot, QUOTA_SEGMENT),
    });
  })
).pipe(Layer.provide(FetchHttpClient.layer));
