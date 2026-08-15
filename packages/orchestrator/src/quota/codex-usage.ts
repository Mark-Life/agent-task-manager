/**
 * Reading Codex's subscription allowance without spending any of it.
 *
 * The endpoint is the one Codex's own UI reads, and it is the only proactive
 * source there is: the SDK and `codex exec --json` report token counts but no
 * rate-limit windows, and the app-server route that would report them costs
 * millions of tokens to initialize. A GET here returns the rolling windows and
 * generates nothing.
 *
 * Everything said in `./claude-usage` about degrading rather than throwing
 * applies identically, and for the same reason: the body is undocumented, so a
 * shape change must read as "could not tell" and never as "drained". The
 * differences are all spelling — this body nests the windows under `rate_limit`,
 * reports `used_percent` rather than `utilization`, stamps the reset in unix
 * seconds, and does carry an explicit reached flag.
 *
 * Field spellings are pinned to `fixtures/wham-usage.json`, which the tests read
 * rather than restating.
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

/** The passive usage endpoint behind the ChatGPT plan. */
const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/**
 * What the Codex CLI names the credentials it refreshes, inside `CODEX_HOME`.
 * Read out of the agent home the containers are handed rather than out of
 * `~/.codex`, for the reason `./claude-usage` gives: on a server the operator's
 * own login is not there, and on a laptop it is a different subscription.
 */
const CODEX_CREDENTIALS_FILE = "auth.json";

/** The reset is a unix-seconds stamp; everything downstream speaks milliseconds. */
const SECONDS_TO_MS = 1000;

/** Named so the request is identifiable in someone else's access log. */
const USER_AGENT = "agent-task-manager-quota-gate";

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
 * One nested window object, or null when it is absent or unusable.
 *
 * The span comes off `limit_window_seconds`, which is what settles what these
 * two windows actually are rather than what a plan's documentation implies:
 * captured live, `primary_window` is 18000 seconds and `secondary_window` is
 * 604800 — five hours and seven days, the same pair Claude reports, and not the
 * daily window the plan pages describe.
 */
const parseWindow = (raw: unknown): WindowUsage | null => {
  const window = asRecord(raw);
  if (window === null || !isFiniteNumber(window.used_percent)) {
    return null;
  }
  return {
    resetsAtMs: isFiniteNumber(window.reset_at)
      ? window.reset_at * SECONDS_TO_MS
      : null,
    utilizationPercent: window.used_percent,
    windowSeconds: isFiniteNumber(window.limit_window_seconds)
      ? window.limit_window_seconds
      : null,
  };
};

/** The provider's own word for which window it hit, normalized or dropped. */
const parseReachedWindow = (raw: unknown): QuotaWindow | null => {
  if (raw === "primary" || raw === "secondary") {
    return raw;
  }
  return null;
};

/**
 * The body as the gate reads it. Pure and total; a body without the `rate_limit`
 * object is unavailable rather than empty, because an empty reading would look
 * like a provider with all its allowance intact.
 */
export const parseWhamUsage = (raw: unknown): ProviderUsage => {
  const root = asRecord(raw);
  const limits = root === null ? null : asRecord(root.rate_limit);
  if (root === null || limits === null) {
    return UNAVAILABLE_USAGE;
  }
  return {
    available: true,
    // Either spelling is the provider saying it will not serve.
    limitReached: limits.limit_reached === true || limits.allowed === false,
    primary: parseWindow(limits.primary_window),
    reachedWindow: parseReachedWindow(root.rate_limit_reached_type),
    secondary: parseWindow(limits.secondary_window),
  };
};

/**
 * The read could not produce a signal. Typed rather than thrown, with the reason
 * kept as the discriminant that tells a self-disabled gate from a real drain.
 */
export class CodexUsageUnavailable extends Schema.TaggedErrorClass<CodexUsageUnavailable>()(
  "Quota.CodexUsageUnavailable",
  {
    cause: Schema.Unknown,
    reason: Schema.Literals(["auth-read", "auth-parse", "no-token"]),
  }
) {}

/** The bearer token, and the account header the endpoint wants where one exists. */
interface CodexCredentials {
  readonly accountId: string | null;
  readonly token: string;
}

/**
 * The credentials off disk. The file belongs to the Codex CLI, which rewrites it
 * on every refresh, so it is read through the same defensive helpers as the
 * response body: a file whose shape moved lands as `no-token`, which is
 * unavailable, rather than as a token-shaped `undefined` in a header.
 */
const readCredentials = (fs: FileSystem, authPath: string) =>
  fs.readFileString(authPath).pipe(
    Effect.mapError(
      (cause) => new CodexUsageUnavailable({ cause, reason: "auth-read" })
    ),
    Effect.flatMap((text) =>
      Effect.try({
        catch: (cause) =>
          new CodexUsageUnavailable({ cause, reason: "auth-parse" }),
        try: (): unknown => JSON.parse(text),
      })
    ),
    Effect.flatMap((auth) => {
      const tokens = asRecord(asRecord(auth)?.tokens);
      const token = tokens?.access_token;
      if (typeof token !== "string" || token.length === 0) {
        return Effect.fail(
          new CodexUsageUnavailable({ cause: null, reason: "no-token" })
        );
      }
      const accountId = tokens?.account_id;
      return Effect.succeed<CodexCredentials>({
        accountId:
          typeof accountId === "string" && accountId.length > 0
            ? accountId
            : null,
        token,
      });
    })
  );

/** Overrides: a test's endpoint. */
export interface CodexUsageOptions {
  readonly url?: string;
}

/** What the reader is handed once, at gate construction. */
export interface CodexUsageInput {
  /** The provider's system-owned login directory — the one mounted into every container. */
  readonly agentHomeDir: string;
  readonly fs: FileSystem;
  readonly http: HttpClient.HttpClient;
  readonly options?: CodexUsageOptions;
}

/**
 * Reads the live allowance. Always succeeds: every failure collapses to
 * {@link UNAVAILABLE_USAGE} so the gate fails open with an alert rather than
 * failing the dispatch it was asked about. Only a 200 body can produce a drain.
 */
export const fetchCodexUsage = ({
  agentHomeDir,
  fs,
  http,
  options,
}: CodexUsageInput): Effect.Effect<ProviderUsage> =>
  readCredentials(fs, join(agentHomeDir, CODEX_CREDENTIALS_FILE)).pipe(
    Effect.flatMap((credentials) =>
      http.execute(
        HttpClientRequest.get(options?.url ?? WHAM_USAGE_URL).pipe(
          HttpClientRequest.bearerToken(credentials.token),
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeaders({
            "User-Agent": USER_AGENT,
            ...(credentials.accountId === null
              ? {}
              : { "ChatGPT-Account-Id": credentials.accountId }),
          })
        )
      )
    ),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.map(parseWhamUsage),
    Effect.catchCause((cause) =>
      Effect.logInfo("quota: codex usage read failed", cause).pipe(
        Effect.as(UNAVAILABLE_USAGE)
      )
    )
  );
