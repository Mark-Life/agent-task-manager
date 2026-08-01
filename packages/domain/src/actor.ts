import { Schema } from "effect";
import { ActorKind } from "./enums";
import { AgentSessionId, RunId, TaskId, UserId } from "./ids";

/**
 * A person clicking in the dashboard or typing in the bot. The only actor that
 * may spend a worker slot.
 */
const HumanActor = Schema.Struct({
  kind: Schema.tag("human"),
  userId: UserId,
});

/**
 * The manager agent, acting on someone's behalf. It carries the user it speaks
 * for and the chat thread that prompted it, so "which conversation edited this
 * task" has an answer before there is a thread table.
 */
const ManagerActor = Schema.Struct({
  kind: Schema.tag("manager"),
  threadId: Schema.optionalKey(Schema.String),
  userId: UserId,
});

/**
 * A worker agent writing through its task-scoped token. It knows its own run
 * and session, which is what lets a repository check that a write lands on the
 * task the run was dispatched for.
 */
const WorkerRunActor = Schema.Struct({
  kind: Schema.tag("worker_run"),
  runId: RunId,
  sessionId: AgentSessionId,
  taskId: TaskId,
});

/**
 * The orchestrator loop, which writes most rows in the system. `runId` is
 * absent for work that is not about one run — the startup reconcile, the quota
 * gate — and present for everything the run lifecycle does.
 */
const OrchestratorActor = Schema.Struct({
  kind: Schema.tag("orchestrator"),
  loopInstance: Schema.String,
  runId: Schema.optionalKey(RunId),
});

/** The seed script and nothing else. `reason` says which one, since there is no user to name. */
const SystemActor = Schema.Struct({
  kind: Schema.tag("system"),
  reason: Schema.String,
});

/**
 * Who is performing a mutation. Carried as an Effect service requirement rather
 * than a parameter, so a write with nobody behind it does not compile, and
 * flattened onto every audit row so the answer survives the request.
 *
 * The discriminant is `kind` and its values are exactly `ActorKind`, so the
 * audit column is the tag and no mapping table sits in between.
 */
export const Actor = Schema.Union([
  HumanActor,
  ManagerActor,
  WorkerRunActor,
  OrchestratorActor,
  SystemActor,
]).pipe(Schema.toTaggedUnion("kind"));
export type Actor = typeof Actor.Type;

/**
 * The actor columns an intervention carries. Flattened rather than stored as a
 * blob, because "everything this run touched" and "what did the manager change"
 * are ordinary indexed queries.
 */
export const commandActorFields = {
  actorKind: ActorKind,
  actorRunId: Schema.NullOr(RunId),
  actorSessionId: Schema.NullOr(AgentSessionId),
  actorUserId: Schema.NullOr(UserId),
};

/**
 * The audit row's actor columns: the same, plus the manager chat thread that
 * caused the write. No foreign key — the thread table lands much later, and
 * without the id "which conversation edited this task" is unanswerable and the
 * bot cannot reply in the right place.
 */
export const auditActorFields = {
  ...commandActorFields,
  actorThreadId: Schema.NullOr(Schema.String),
};

/** The full flattened actor, as an audit row holds it. */
export const ActorAttribution = Schema.Struct(auditActorFields);

export interface ActorAttribution
  extends Schema.Schema.Type<typeof ActorAttribution> {}

/**
 * Flattens an actor into those columns. One place, so adding a variant is a
 * compile error here instead of a row that quietly attributes itself to nobody.
 */
export const flattenActor = (actor: Actor) =>
  Actor.match(actor, {
    human: (self) =>
      ({
        actorKind: self.kind,
        actorRunId: null,
        actorSessionId: null,
        actorThreadId: null,
        actorUserId: self.userId,
      }) satisfies ActorAttribution,
    manager: (self) =>
      ({
        actorKind: self.kind,
        actorRunId: null,
        actorSessionId: null,
        actorThreadId: self.threadId ?? null,
        actorUserId: self.userId,
      }) satisfies ActorAttribution,
    orchestrator: (self) =>
      ({
        actorKind: self.kind,
        actorRunId: self.runId ?? null,
        actorSessionId: null,
        actorThreadId: null,
        actorUserId: null,
      }) satisfies ActorAttribution,
    system: (self) =>
      ({
        actorKind: self.kind,
        actorRunId: null,
        actorSessionId: null,
        actorThreadId: null,
        actorUserId: null,
      }) satisfies ActorAttribution,
    worker_run: (self) =>
      ({
        actorKind: self.kind,
        actorRunId: self.runId,
        actorSessionId: self.sessionId,
        actorThreadId: null,
        actorUserId: null,
      }) satisfies ActorAttribution,
  });
