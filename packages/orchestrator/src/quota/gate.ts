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
 * The pause record is a small file rather than memory, so a loop restarting
 * inside a drain does not immediately re-probe with a burst of runs. Everything
 * else is in memory and re-derives from the live signals.
 *
 * The cooldown is always the conservative one, never a reset the signal carried.
 * Both reactive sources report their reset best-effort and frequently omit it,
 * so honouring one would resume dispatch into a wall; the proactive read owns
 * the exact reset and resumes a still-drained provider precisely.
 */

import { join } from "node:path";
import type { SessionProvider } from "@workspace/domain";
import type { RateLimitStatus } from "@workspace/harness";
import { Clock, Context, Effect, Layer, Ref, Semaphore } from "effect";
import { FileSystem } from "effect/FileSystem";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { orchestratorConfig } from "../config";
import { QuotaPaused } from "../errors";
import { fetchClaudeUsage } from "./claude-usage";
import { fetchCodexUsage } from "./codex-usage";
import { QUOTA_SEGMENT, type QuotaConfig, quotaConfig } from "./config";
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

/** A live read of one provider's allowance. Always succeeds — see the readers. */
export type UsageReader = () => Effect.Effect<ProviderUsage>;

/** One cached read, with the moment it was taken. */
interface CachedUsage {
  readonly atMs: number;
  readonly usage: ProviderUsage;
}

/** Everything the gate keeps per provider. Isolated, so one drain gates one provider. */
interface ProviderState {
  /** Tasks already told about the current pause episode, so the loud surface says it once. */
  readonly announced: Ref.Ref<ReadonlySet<string>>;
  readonly cache: Ref.Ref<CachedUsage | null>;
  /** Present only where the provider says it in prose rather than in a field. */
  readonly detectText: ((message: string) => boolean) | null;
  readonly readUsage: UsageReader;
}

/** What building a gate needs: the settings, where to write, and any test readers. */
export interface QuotaGateOptions extends QuotaConfig {
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

/** One task asking whether it has already been told about this pause. */
export interface AnnounceRequest {
  readonly provider: SessionProvider;
  readonly taskId: string;
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

    /** The reader for a provider: a test's, the real one, or none at all. */
    const readerFor = (provider: SessionProvider): UsageReader => {
      const injected = options.readers?.[provider];
      if (injected !== undefined) {
        return injected;
      }
      if (!options.proactive) {
        return () => Effect.succeed(UNAVAILABLE_USAGE);
      }
      return provider === "codex"
        ? () => fetchCodexUsage({ fs, http })
        : () => fetchClaudeUsage({ fs, http });
    };

    const states = new Map<SessionProvider, ProviderState>();
    for (const provider of options.providers) {
      states.set(provider, {
        announced: yield* Ref.make<ReadonlySet<string>>(new Set()),
        cache: yield* Ref.make<CachedUsage | null>(null),
        // Only Codex needs the prose matcher: Claude's reading arrives as a
        // field on the usage event and goes through `noteRateLimit`.
        detectText: provider === "codex" ? detectUsageLimitText : null,
        readUsage: readerFor(provider),
      });
    }

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
      pauseOf(provider).pipe(
        Effect.map((record) =>
          record !== null && nowMs < record.until ? record : null
        )
      );

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
     */
    const cachedUsage = (
      provider: SessionProvider,
      state: ProviderState,
      nowMs: number
    ) =>
      Effect.gen(function* () {
        const cached = yield* Ref.get(state.cache);
        if (cached !== null && nowMs - cached.atMs < options.pollIntervalMs) {
          return cached.usage;
        }
        const usage = yield* state.readUsage();
        yield* Ref.set(state.cache, { atMs: nowMs, usage });
        yield* recordUtilization(provider, usage);
        if (usage.available) {
          return usage;
        }
        yield* quotaReadFailures
          .increment({
            provider,
            reason: options.proactive ? "unavailable" : "off",
          })
          .pipe(Effect.ignoreCause);
        if (options.proactive) {
          yield* Effect.logWarning(
            `quota: ${provider} usage read produced no signal — dispatching anyway`
          );
        }
        return usage;
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
     * drain, an unreadable signal then fails open, a stated limit beats a
     * threshold, and the short window is checked before the long one so the
     * shorter wait is the one reported.
     */
    const evaluate = (input: {
      readonly inflight: number;
      readonly pause: PauseRecord | null;
      readonly usage: ProviderUsage;
    }): QuotaDecision => {
      if (input.pause !== null) {
        return defer(input.pause.window, input.pause.reason, input.pause.until);
      }
      if (!input.usage.available) {
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
      const cached = yield* Ref.get(state.cache);
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
     * True the first time a task is offered during the current pause episode, so
     * the loud surface says it once per task per drain rather than once per pass.
     */
    const announceOnce = (request: AnnounceRequest) => {
      const state = states.get(request.provider);
      if (state === undefined) {
        return Effect.succeed(false);
      }
      return Ref.modify(state.announced, (seen) =>
        seen.has(request.taskId)
          ? ([false, seen] as const)
          : ([true, new Set([...seen, request.taskId])] as const)
      );
    };

    return {
      admit,
      announceOnce,
      describe,
      noteError,
      noteRateLimit,
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
    const { dataRoot } = yield* orchestratorConfig;
    const config = yield* quotaConfig;
    return yield* makeGate({
      ...config,
      stateDir: join(dataRoot, QUOTA_SEGMENT),
    });
  })
).pipe(Layer.provide(FetchHttpClient.layer));
