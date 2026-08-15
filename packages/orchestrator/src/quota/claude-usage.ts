/**
 * Reading Claude's subscription allowance without spending any of it.
 *
 * The endpoint is the same passive one the Claude CLI reads to show remaining
 * quota: a GET returns the rolling windows and generates nothing, so polling it
 * is free. It is also undocumented, which is why every field access below
 * degrades rather than throws — a body that changed shape has to read as "could
 * not tell", never as "drained", because the two have opposite consequences.
 *
 * The token is re-read from disk every poll and never cached. The Claude SDK
 * rotates it on its own cadence, and a cached one simply 401s after expiry —
 * which lands as unavailable, distinct from a drain.
 *
 * It is read out of the *agent home* — the system-owned login directory every
 * container is handed — and never out of `~/.claude`. Those are two different
 * subscriptions on any host where a person also uses the CLI, and on a server
 * the operator's one does not exist at all. The allowance worth reporting is the
 * one the runs spend.
 *
 * Field spellings are pinned to a captured live response in
 * `fixtures/claude-oauth-usage.json`, and the tests read that file rather than a
 * hand-written object: the endpoint's shape is the load-bearing assumption here,
 * so the fixture is the assumption written down.
 */

import { join } from "node:path";
import { Effect, Schema } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { HttpClient } from "effect/unstable/http";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  type ProviderUsage,
  type QuotaWindow,
  UNAVAILABLE_USAGE,
  type WindowUsage,
} from "./types";

/** The passive OAuth usage endpoint. */
const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/**
 * The beta tag the endpoint requires. Overridable rather than inlined because
 * it is an undocumented contract Anthropic can rotate, and rotating it should be
 * a config change and not a release.
 */
export const OAUTH_BETA_HEADER = "oauth-2025-04-20";

/** What the Claude CLI names the credentials it refreshes, inside its config directory. */
const CLAUDE_CREDENTIALS_FILE = ".credentials.json";

/** A window is drained at 100%; the provider reports no explicit flag of its own. */
const FULL_UTILIZATION = 100;

/** Every weekly window key carries this prefix: account-wide, per-model, per-feature. */
const WEEKLY_PREFIX = "seven_day";

/**
 * How long each window is, in seconds, taken from the key that names it. This
 * body states the span in its field names rather than in a value — `five_hour`,
 * `seven_day` — so this is that name read as a number, and it moves when the
 * spelling does rather than drifting quietly behind it.
 */
const FIVE_HOUR_SECONDS = 18_000;
const SEVEN_DAY_SECONDS = 604_800;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Whether a parsed JSON value is a plain object, which every window and the body
 * around them is. Arrays are excluded on purpose: one answers `undefined` to
 * every field read, so a window arriving as `[]` would report as "not limiting"
 * instead of as a shape this reader cannot read.
 */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A nested object field, or null when it is absent or of another shape. */
const asRecord = (value: unknown) => (isRecord(value) ? value : null);

/**
 * One window of the flat body. `utilization` is already 0–100 here, so nothing
 * is rescaled; `resets_at` is an ISO string, and a garbled one degrades the
 * reset to null rather than the whole read. A window that is absent or malformed
 * reads as "this window is not limiting", which is the steady state — most of
 * the per-model windows are `null` unless that bucket itself is limited.
 */
const parseWindow = (
  raw: unknown,
  windowSeconds: number
): WindowUsage | null => {
  const window = asRecord(raw);
  if (window === null || !isFiniteNumber(window.utilization)) {
    return null;
  }
  const resetsAt =
    typeof window.resets_at === "string"
      ? Date.parse(window.resets_at)
      : Number.NaN;
  return {
    resetsAtMs: Number.isNaN(resetsAt) ? null : resetsAt,
    utilizationPercent: window.utilization,
    windowSeconds,
  };
};

/**
 * The most-constraining weekly window. `ProviderUsage` carries one long-window
 * slot while the endpoint reports an account-wide `seven_day` plus per-model and
 * per-feature siblings, so they are scanned by prefix rather than by an
 * allow-list — a bucket added upstream folds into the worst reading instead of
 * slipping past a list nobody updated.
 */
const parseWeekly = (root: Readonly<Record<string, unknown>>) => {
  let worst: WindowUsage | null = null;
  for (const key of Object.keys(root)) {
    if (!key.startsWith(WEEKLY_PREFIX)) {
      continue;
    }
    const window = parseWindow(root[key], SEVEN_DAY_SECONDS);
    if (
      window !== null &&
      (worst === null || window.utilizationPercent > worst.utilizationPercent)
    ) {
      worst = window;
    }
  }
  return worst;
};

/**
 * Whether the paid-overflow bucket is already drawing credits. Treated as a hard
 * drain: overflow only spends once a subscription window is full, so a run
 * started here is a run billed by the card rather than covered by the plan, and
 * spilling into that silently is the failure worth pausing for.
 */
const isOverflowActive = (root: Readonly<Record<string, unknown>>) => {
  const extra = asRecord(root.extra_usage);
  return (
    extra !== null &&
    extra.is_enabled === true &&
    isFiniteNumber(extra.used_credits) &&
    extra.used_credits > 0
  );
};

/**
 * The body as the gate reads it. Pure and total: a non-object body is
 * unavailable, and everything below that degrades field by field.
 *
 * There is no `limit_reached` flag to read, so a drain is inferred three ways —
 * a window pinned at 100%, or the overflow bucket already spending. The reached
 * window picks the resume time: a full week wins because it is the longest wait,
 * and overflow with neither window self-reporting full defaults to the short
 * window so the gate re-checks in hours rather than idling for a week.
 */
export const parseOauthUsage = (raw: unknown): ProviderUsage => {
  const root = asRecord(raw);
  if (root === null) {
    return UNAVAILABLE_USAGE;
  }
  const primary = parseWindow(root.five_hour, FIVE_HOUR_SECONDS);
  const secondary = parseWeekly(root);
  const primaryFull =
    primary !== null && primary.utilizationPercent >= FULL_UTILIZATION;
  const secondaryFull =
    secondary !== null && secondary.utilizationPercent >= FULL_UTILIZATION;
  const overflow = isOverflowActive(root);

  let reachedWindow: QuotaWindow | null = null;
  if (secondaryFull) {
    reachedWindow = "secondary";
  } else if (primaryFull || overflow) {
    reachedWindow = "primary";
  }

  return {
    available: true,
    limitReached: primaryFull || secondaryFull || overflow,
    primary,
    reachedWindow,
    secondary,
  };
};

/**
 * The read could not produce a signal. Typed rather than thrown, and the reason
 * is the discriminant that tells a gate which disabled itself apart from a
 * provider that is genuinely out.
 */
export class ClaudeUsageUnavailable extends Schema.TaggedErrorClass<ClaudeUsageUnavailable>()(
  "Quota.ClaudeUsageUnavailable",
  {
    cause: Schema.Unknown,
    reason: Schema.Literals(["auth-read", "auth-parse", "no-token"]),
  }
) {}

/**
 * The token off disk. The credentials file is written by the Claude CLI and
 * carries far more than this needs, so it is read through the same defensive
 * helpers as the response body: a file whose shape moved lands as `no-token`,
 * which is unavailable, rather than as a token-shaped `undefined` in a header.
 */
const readToken = (fs: FileSystem, authPath: string) =>
  fs.readFileString(authPath).pipe(
    Effect.mapError(
      (cause) => new ClaudeUsageUnavailable({ cause, reason: "auth-read" })
    ),
    Effect.flatMap((text) =>
      Effect.try({
        catch: (cause) =>
          new ClaudeUsageUnavailable({ cause, reason: "auth-parse" }),
        try: (): unknown => JSON.parse(text),
      })
    ),
    Effect.flatMap((auth) => {
      const token = asRecord(asRecord(auth)?.claudeAiOauth)?.accessToken;
      return typeof token === "string" && token.length > 0
        ? Effect.succeed(token)
        : Effect.fail(
            new ClaudeUsageUnavailable({ cause: null, reason: "no-token" })
          );
    })
  );

/** Overrides: a test's endpoint, or a rotated beta tag. */
export interface ClaudeUsageOptions {
  readonly betaHeader?: string;
  readonly url?: string;
}

/** What the reader is handed once, at gate construction. */
export interface ClaudeUsageInput {
  /** The provider's system-owned login directory — the one mounted into every container. */
  readonly agentHomeDir: string;
  readonly fs: FileSystem;
  readonly http: HttpClient.HttpClient;
  readonly options?: ClaudeUsageOptions;
}

/**
 * Reads the live allowance. Always succeeds: credentials failures and HTTP
 * failures alike collapse to {@link UNAVAILABLE_USAGE}, so the gate fails open
 * with an alert rather than failing the dispatch it was asked about. Only a 200
 * body can produce a drain.
 */
export const fetchClaudeUsage = ({
  agentHomeDir,
  fs,
  http,
  options,
}: ClaudeUsageInput): Effect.Effect<ProviderUsage> =>
  readToken(fs, join(agentHomeDir, CLAUDE_CREDENTIALS_FILE)).pipe(
    Effect.flatMap((token) =>
      http.execute(
        HttpClientRequest.get(options?.url ?? OAUTH_USAGE_URL).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeaders({
            "anthropic-beta": options?.betaHeader ?? OAUTH_BETA_HEADER,
          })
        )
      )
    ),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.map(parseOauthUsage),
    // Logged at info carrying the cause: the reason discriminant is what tells a
    // stale token apart from a real drain, so it has to survive a log filter.
    // The loud warning belongs to the gate, which knows it is failing open.
    Effect.catchCause((cause) =>
      Effect.logInfo("quota: claude usage read failed", cause).pipe(
        Effect.as(UNAVAILABLE_USAGE)
      )
    )
  );
