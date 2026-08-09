/**
 * The failures this API answers with, and the status each one is.
 *
 * They mirror the repository errors `@workspace/db` raises one for one, but
 * they are not those errors: this package may not import the store, and a wire
 * contract that named `Db.NotFound` would make the persistence layer's tag a
 * public promise nobody could change afterwards. So the store's failures are
 * translated at the handler boundary, and the name a client sees belongs to the
 * API.
 *
 * The mapping, so the translation is written down once:
 *
 * | store failure | wire failure | status |
 * | --- | --- | --- |
 * | `Db.NotFound` | {@link NotFound} | 404 |
 * | `Db.InvalidInput` | {@link InvalidInput} | 422 |
 * | `TaskRepo.IllegalTransition` | {@link IllegalTransition} | 409 |
 * | `TaskRepo.IllegalInitialStatus` | {@link IllegalInitialStatus} | 409 |
 * | `TaskRepo.IllegalDeletion` | {@link IllegalDeletion} | 403 |
 * | `RunRepo.AlreadyLive` | {@link RunAlreadyLive} | 409 |
 * | `RunRepo.NotLive` | {@link RunNotLive} | 409 |
 * | `AgentSessionRepo.Ended` | {@link AgentSessionEnded} | 409 |
 * | `ArtifactRepo.AlreadyPromoted` | {@link ArtifactAlreadyPromoted} | 409 |
 * | `ProposalRepo.AlreadyDecided` | {@link ProposalAlreadyDecided} | 409 |
 * | `RunEventRepo.TooLarge` | {@link PayloadTooLarge} | 413 |
 *
 * `Db.MalformedRow` and `Db.PersistenceError` are deliberately absent. A row
 * that no longer decodes, or a driver that fell over, is not something a caller
 * did or can do anything about — it is a defect, and a handler dies on it so it
 * reaches the wide event and the ledger as a 500 rather than as a documented
 * outcome an agent might branch on.
 */

import { ActorKind, TaskStatus } from "@workspace/domain";
import { Schema } from "effect";
import "effect/unstable/httpapi";

/** No such row in this workspace. Scoping is why the id alone does not answer it. */
export class NotFound extends Schema.TaggedErrorClass<NotFound>()(
  "NotFound",
  { entity: Schema.String, id: Schema.String },
  { httpApiStatus: 404 }
) {}

/**
 * The body decoded but the store refused it: an empty title, a value outside a
 * literal union. 422 rather than 400, because the request was well-formed and
 * the content was not.
 */
export class InvalidInput extends Schema.TaggedErrorClass<InvalidInput>()(
  "InvalidInput",
  { detail: Schema.String, entity: Schema.String },
  { httpApiStatus: 422 }
) {}

/**
 * The move is not in the status machine, or is but not for this kind of actor.
 * Carries both halves of the move and the actor, so a client can say why rather
 * than only that.
 */
export class IllegalTransition extends Schema.TaggedErrorClass<IllegalTransition>()(
  "IllegalTransition",
  {
    actorKind: ActorKind,
    from: TaskStatus,
    taskId: Schema.String,
    to: TaskStatus,
  },
  { httpApiStatus: 409 }
) {}

/** The task would have been filed into a column this actor may not reach. */
export class IllegalInitialStatus extends Schema.TaggedErrorClass<IllegalInitialStatus>()(
  "IllegalInitialStatus",
  { actorKind: ActorKind, status: TaskStatus },
  { httpApiStatus: 409 }
) {}

/**
 * This kind of actor may not erase a task. A person and the manager acting for
 * one own what is on the board; a run does not, however good its token is for
 * writes on the task it was dispatched for.
 *
 * 403 rather than the 409 its two siblings carry, because there is no state a
 * caller could reach where this answer changes: it is about who is asking, and
 * nothing about the row.
 */
export class IllegalDeletion extends Schema.TaggedErrorClass<IllegalDeletion>()(
  "IllegalDeletion",
  { actorKind: ActorKind, taskId: Schema.String },
  { httpApiStatus: 403 }
) {}

/**
 * The task already has a queued or running run. One run per task at a time is
 * what stops two containers writing the same artifacts directory.
 */
export class RunAlreadyLive extends Schema.TaggedErrorClass<RunAlreadyLive>()(
  "RunAlreadyLive",
  { liveRunId: Schema.String, taskId: Schema.String },
  { httpApiStatus: 409 }
) {}

/** The run has already reached a terminus, so there is nothing to stop. */
export class RunNotLive extends Schema.TaggedErrorClass<RunNotLive>()(
  "RunNotLive",
  { runId: Schema.String, status: Schema.String },
  { httpApiStatus: 409 }
) {}

/** The session has already stopped; ending it twice would overwrite why it ended. */
export class AgentSessionEnded extends Schema.TaggedErrorClass<AgentSessionEnded>()(
  "AgentSessionEnded",
  { sessionId: Schema.String, status: Schema.String },
  { httpApiStatus: 409 }
) {}

/**
 * The file has already been promoted. Promotion is a deliberate verb whose
 * audit row is the trail, and a second one would claim a decision nobody made.
 */
export class ArtifactAlreadyPromoted extends Schema.TaggedErrorClass<ArtifactAlreadyPromoted>()(
  "ArtifactAlreadyPromoted",
  { artifactId: Schema.String },
  { httpApiStatus: 409 }
) {}

/**
 * Somebody has already answered this proposal. An accepted one has been written
 * into a shared directory and recorded in that directory's git history, so a
 * second answer would either overwrite a decision or claim one nobody made.
 */
export class ProposalAlreadyDecided extends Schema.TaggedErrorClass<ProposalAlreadyDecided>()(
  "ProposalAlreadyDecided",
  { proposalId: Schema.String, state: Schema.String },
  { httpApiStatus: 409 }
) {}

/** The upload is over the limit this endpoint accepts. Named in bytes, both sides. */
export class PayloadTooLarge extends Schema.TaggedErrorClass<PayloadTooLarge>()(
  "PayloadTooLarge",
  { bytes: Schema.Number, limit: Schema.Number },
  { httpApiStatus: 413 }
) {}

/**
 * No credential, or one that no longer resolves to an actor. A rejected token
 * is a row on the request event carrying scope and reason — never a bare 401
 * that vanishes.
 */
export class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()(
  "Unauthorized",
  { reason: Schema.String },
  { httpApiStatus: 401 }
) {}

/**
 * A real credential that does not reach this operation: the scope is below what
 * the endpoint asks for, or a run's token was pointed at a task that is not its
 * own.
 */
export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()(
  "Forbidden",
  { reason: Schema.String, required: Schema.String },
  { httpApiStatus: 403 }
) {}

/**
 * A good credential asked too often. Only a user's API key can reach this: keys
 * carry a per-key quota the auth library counts on the row itself, and the
 * signed tokens an agent run holds are verified by arithmetic against no row at
 * all, so nothing counts them and nothing can refuse them here.
 *
 * It is its own status rather than a 401 because the two mean opposite things
 * to whoever is holding the key. A 401 says the credential is wrong and the
 * repair is a new key; this says the credential is right and the repair is to
 * wait. Answering the second with the first is how somebody spends an evening
 * re-issuing a key that was never the problem.
 */
export class TooManyRequests extends Schema.TaggedErrorClass<TooManyRequests>()(
  "TooManyRequests",
  { reason: Schema.String },
  { httpApiStatus: 429 }
) {}
