/**
 * What the request event is told about the credential — the seam, and the only
 * thing this side of authentication says about telemetry.
 *
 * A rejected credential is a fact worth counting: which scope was asked for,
 * which was held, why it was refused, and by whom. Emitting a second wide event
 * for it would split "what happened on this request" across two markers that
 * nobody could join, so the fields land on the one request event instead —
 * `atm.request`, which belongs to the middleware in `../layers`, not here.
 *
 * The seam is deliberately loose in one direction and strict in the other. The
 * writer — every access middleware — asks for {@link RequestAuth} with
 * `Effect.serviceOption` and does nothing when it is absent, so authentication
 * works in a process that has no request event yet and in a test that provides
 * one and reads it back. The reader owns the lifetime: it builds one recorder
 * per request with {@link makeRequestAuth}, provides it around the handler, and
 * reads it at emit time. A recorder provided once for the whole process would
 * report the previous request's credential on this one, which is worse than
 * reporting none.
 *
 * Until that middleware exists, a refusal still leaves a line: rejections are
 * logged at `Warn` with the same fields. That is narration for an operator
 * watching a deploy, not the ledger — the fields below are the countable
 * record, and the log line goes away the day it would duplicate one.
 */

import type { ApiScope } from "@workspace/api";
import type {
  ActorKind,
  AgentSessionId,
  RunId,
  TaskId,
  UserId,
  WorkspaceId,
} from "@workspace/domain";
import { Context, Effect, Option, Ref } from "effect";

/**
 * How a credential arrived, or that none did. `api_key` is a person's own key
 * in its own header; `bearer` is the system's signed token. They are counted
 * apart because "who is reaching this board" is a question an operator asks of
 * exactly this field, and folding a user's integration in with the agents would
 * make it unanswerable.
 */
export const AUTH_SCHEMES = ["api_key", "bearer", "session", "none"] as const;

/** The scheme a request presented. */
export type AuthScheme = (typeof AUTH_SCHEMES)[number];

/**
 * Whether the door opened, and if not, which way it was shut. `rate_limited` is
 * a credential that was good and had asked too often — a fourth answer rather
 * than a shade of the other two, because an operator reading a spike of these
 * is looking at a runaway integration and not at anything broken.
 */
export const AUTH_OUTCOMES = [
  "granted",
  "unauthorized",
  "forbidden",
  "rate_limited",
] as const;

/** What the access check decided. */
export type AuthOutcome = (typeof AUTH_OUTCOMES)[number];

/**
 * The credential's side of one request, flat and event-ready.
 *
 * Every field is either a bounded literal or a high-cardinality id, which is
 * the same split the wide-event vocabulary makes: the literals are what a
 * metric may be tagged by, the ids are what an investigation joins on. Nothing
 * here is the credential itself, and `authReason` is a literal from a closed
 * set rather than free text, so no part of a token can reach a durable sink
 * through this record.
 */
export interface AuthRecord {
  readonly actorKind: ActorKind | null;
  /** The run's own task, when the credential is bound to one. */
  readonly authBoundTaskId: TaskId | null;
  readonly authOutcome: AuthOutcome;
  /** Why it was refused, from a closed set. Null when it was granted. */
  readonly authReason: string | null;
  /** What the endpoint asked for. */
  readonly authRequired: ApiScope;
  readonly authScheme: AuthScheme;
  /** What the credential turned out to hold. Null when nothing resolved. */
  readonly authScope: ApiScope | null;
  readonly runId: RunId | null;
  readonly sessionId: AgentSessionId | null;
  readonly userId: UserId | null;
  readonly workspaceId: WorkspaceId | null;
}

/** The recorder for one request. */
export interface RequestAuthShape {
  /** What was decided, or `null` while the check has not run. */
  readonly get: Effect.Effect<AuthRecord | null>;
  /** Records the decision. Last writer wins; there is one per request. */
  readonly set: (record: AuthRecord) => Effect.Effect<void>;
}

/**
 * Where the access middleware leaves its verdict for the request event to pick
 * up. Request-scoped: see {@link makeRequestAuth}.
 */
export class RequestAuth extends Context.Service<
  RequestAuth,
  RequestAuthShape
>()("gateway/RequestAuth") {}

/**
 * A fresh recorder. Provide it per request —
 * `Effect.provideServiceEffect(handler, RequestAuth, makeRequestAuth)` — so the
 * verdict on the event is the one this request produced.
 */
export const makeRequestAuth = Effect.map(
  Ref.make<AuthRecord | null>(null),
  (ref): RequestAuthShape => ({
    get: Ref.get(ref),
    set: (record) => Ref.set(ref, record),
  })
);

/** The record's fields as log annotations, nulls dropped the way the ledger drops them. */
const annotationsOf = (record: AuthRecord) =>
  Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== null)
  );

/** Whether two verdicts say the same thing about the same request. */
const sameVerdict = (left: AuthRecord | null, right: AuthRecord) =>
  left !== null &&
  left.authOutcome === right.authOutcome &&
  left.authReason === right.authReason &&
  left.authRequired === right.authRequired &&
  left.authScheme === right.authScheme;

/**
 * Files one verdict: onto the request event when something is collecting one,
 * and — for a refusal only — as a warning line so a rejection is never silent
 * in a build that has no request event yet.
 *
 * A refusal is filed once even though it is reached twice. The contract
 * declares each middleware over two named schemes so the document can describe
 * both credentials, and the builder runs every scheme before it gives up — so a
 * request with no credential reaches this twice with the same answer. The row is
 * a last-writer-wins cell and does not care; a second warning line would read as
 * a second refusal, which is the wrong number for an operator to see.
 */
export const recordAuth = (record: AuthRecord) =>
  Effect.gen(function* () {
    const recorder = yield* Effect.serviceOption(RequestAuth);
    const previous = Option.isSome(recorder) ? yield* recorder.value.get : null;
    if (Option.isSome(recorder)) {
      yield* recorder.value.set(record);
    }
    if (record.authOutcome !== "granted" && !sameVerdict(previous, record)) {
      yield* Effect.logWarning(
        `credential refused: ${record.authReason ?? record.authOutcome}`
      ).pipe(Effect.annotateLogs(annotationsOf(record)));
    }
  });
