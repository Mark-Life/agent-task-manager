/**
 * The person's half of a proposal: read what a run asked for, and answer it
 * once.
 *
 * **Confirming is the only path from a worker's request to a shared
 * directory.** A worker's workspace scope is a read-only mount, because a run
 * that has cloned an untrusted repository must not be able to edit the rules
 * every later run is given. This file is what the mount flag leaves open, and it
 * is admin-scoped so that only a person can walk through it: an agent's
 * credential has a `task-write` ceiling and cannot be minted higher, so the
 * refusal is arithmetic on a token rather than a check somebody remembered.
 *
 * **The bytes written are the bytes recorded, never the file on disk.** The
 * proposal file sits in the task's own folder, which later runs on that task can
 * rewrite; re-reading it here would let a run change what a person is accepting
 * in the window between reading it and clicking. The row holds the body for
 * exactly that reason, and this file only decides where it goes.
 *
 * **Nothing here opens a path a caller composed.** The path came off the row,
 * which was branded by a domain rule that refuses `..`, a leading `/` and a
 * `.git` segment — and it is contained again against the scope's real directory
 * before the write, because the gateway runs on the host with the host's reach
 * and a symlink planted in a shared scope by an earlier accepted proposal points
 * wherever it likes.
 *
 * **No second audit trail.** The scope directories are git repositories that
 * `@workspace/sandbox` snapshots around every run, so what actually landed is a
 * commit; the row records who decided and when, and the store writes the audit
 * entry in the same transaction.
 */

import { dirname, relative, resolve, sep } from "node:path";
import {
  Api,
  Forbidden,
  NotFound,
  Principal,
  type PrincipalShape,
  ProposalAlreadyDecided,
} from "@workspace/api";
import {
  type MalformedRow,
  type PersistenceError,
  ProposalRepo,
  type ProposalAlreadyDecided as StoreAlreadyDecided,
  type InvalidInput as StoreInvalidInput,
  type NotFound as StoreNotFound,
  TaskRepo,
  withActor,
} from "@workspace/db";
import type { Proposal, ProposalId, TaskId, UserId } from "@workspace/domain";
import {
  ARTIFACT_DIR_MODE,
  type ArtifactIoFailed,
  ensureArtifactDir,
  globalArtifactsDirOf,
  projectArtifactsDirOf,
} from "@workspace/sandbox";
import { Config, Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { atBuild } from "./at-build";

/** Where the artifacts tree lives when the environment says nothing. Mirrors `@workspace/env`. */
const DEFAULT_DATA_ROOT = ".data";

/** Read here rather than from a service: where the tree lives is not a request's business. */
const dataRootConfig = Config.string("DATA_ROOT").pipe(
  Config.withDefault(DEFAULT_DATA_ROOT)
);

/** Everything the store and the filesystem below a handler can fail with. */
type StoreFailure =
  | ArtifactIoFailed
  | MalformedRow
  | PersistenceError
  | StoreAlreadyDecided
  | StoreInvalidInput
  | StoreNotFound;

/** The store's 404 as the wire's. */
const asNotFound = <A, R>(effect: Effect.Effect<A, StoreFailure, R>) =>
  Effect.catch(effect, (failure) =>
    failure._tag === "Db.NotFound"
      ? Effect.fail(new NotFound({ entity: failure.entity, id: failure.id }))
      : Effect.die(failure)
  );

/** The two a decision can answer: no such row, and an answer already recorded. */
const asDecisionFailure = <A, R>(effect: Effect.Effect<A, StoreFailure, R>) =>
  Effect.catch(
    effect,
    (failure): Effect.Effect<never, NotFound | ProposalAlreadyDecided> => {
      switch (failure._tag) {
        case "Db.NotFound":
          return Effect.fail(
            new NotFound({ entity: failure.entity, id: failure.id })
          );
        case "ProposalRepo.AlreadyDecided":
          return Effect.fail(
            new ProposalAlreadyDecided({
              proposalId: failure.id,
              state: failure.state,
            })
          );
        default:
          return Effect.die(failure);
      }
    }
  );

/** What every operation here needs: whose request it is, and which task's proposals. */
export interface ProposalRequest {
  /** The root the three artifact folders hang off. */
  readonly dataRoot: string;
  readonly principal: PrincipalShape;
  /** From the route, and already checked by the access middleware. */
  readonly taskId: TaskId;
}

/** One proposal of one task, addressed the way the route addresses it. */
export interface ProposalItemRequest extends ProposalRequest {
  readonly proposalId: ProposalId;
}

/** The task, or 404. Everything here is nested under one and none of it may assume it exists. */
const requireTask = Effect.fnUntraced(function* (input: ProposalRequest) {
  const tasks = yield* TaskRepo;
  return yield* tasks
    .byId({ id: input.taskId, workspaceId: input.principal.workspaceId })
    .pipe(asNotFound);
});

/**
 * The proposal row, once it is known to be this task's own.
 *
 * The route is the authority on which task is being read, so an id belonging to
 * another task is a 404 rather than a way through a route whose ownership was
 * already decided.
 */
const requireOwnProposal = Effect.fnUntraced(function* (
  input: ProposalItemRequest
) {
  const proposals = yield* ProposalRepo;
  const row = yield* proposals
    .byId({ id: input.proposalId, workspaceId: input.principal.workspaceId })
    .pipe(asNotFound);
  if (row.taskId !== input.taskId) {
    return yield* Effect.fail(
      new NotFound({ entity: "proposal", id: input.proposalId })
    );
  }
  return row;
});

/**
 * The person answering.
 *
 * The middleware has already refused every credential an agent can hold, so
 * this is a total function over what is left rather than a second check of the
 * same rule. It exists because the column names a human: an actor with nobody
 * behind it — the loop, a seed script — is not making this decision, and a
 * decision attributed to nobody is the one thing this whole path is meant to
 * prevent.
 *
 * The manager carries a user id too, and is refused anyway. It is an agent, and
 * the whole point of the proposal is that an agent does not get to answer one;
 * accepting it here would leave a second door standing open the day a manager
 * credential is ever minted with admin scope.
 */
const deciderOf = (principal: PrincipalShape) =>
  principal.actor.kind === "human"
    ? Effect.succeed(principal.actor.userId satisfies UserId)
    : Effect.fail(
        new Forbidden({
          reason: "a proposal is decided by a person",
          required: "admin",
        })
      );

/** The host directory a proposal's scope names, or 404 where the project is gone. */
const scopeDirOf = (input: {
  readonly dataRoot: string;
  readonly proposal: Proposal;
}) => {
  const { dataRoot, proposal } = input;
  if (proposal.scope === "workspace") {
    return Effect.succeed(globalArtifactsDirOf(dataRoot));
  }
  // The schema's own check keeps these two in step, so a null here is a row
  // written behind the store's back rather than a request anybody made.
  return proposal.projectId === null
    ? Effect.fail(new NotFound({ entity: "project", id: proposal.id }))
    : Effect.succeed(
        projectArtifactsDirOf({ dataRoot, projectId: proposal.projectId })
      );
};

/**
 * Writes one proposal's body into its scope, refusing anything that does not
 * land inside it.
 *
 * Contained twice: `resolve` collapses whatever the path holds and the prefix
 * test refuses what is left outside, and then the parent directory is resolved
 * through its symlinks and tested again. The first check is about the string,
 * which the domain has already refused the obvious forms of; the second is about
 * the disk, where a link inside a shared scope points wherever it was pointed.
 */
const writeIntoScope = Effect.fnUntraced(function* (input: {
  readonly dir: string;
  readonly proposal: Proposal;
}) {
  const fs = yield* FileSystem;
  const root = resolve(input.dir);
  const target = resolve(root, input.proposal.path);
  const refuse = () =>
    Effect.fail(
      new Forbidden({
        reason: "the proposal names a path outside its own scope",
        required: "admin",
      })
    );
  if (!target.startsWith(`${root}${sep}`)) {
    yield* Effect.logWarning("proposal path leaves its scope", {
      path: input.proposal.path,
      proposalId: input.proposal.id,
    });
    return yield* refuse();
  }

  const parent = dirname(target);
  yield* fs
    .makeDirectory(parent, { mode: ARTIFACT_DIR_MODE, recursive: true })
    .pipe(Effect.orDie);
  // After the directory exists, so the answer is about the path that will
  // actually be written rather than about one that does not exist yet.
  const realParent = yield* fs.realPath(parent).pipe(Effect.orDie);
  // A data root reached through a link — `/tmp` on a mac, a mounted volume in
  // production — would otherwise make every path inside it look like an escape.
  const realRoot = yield* fs
    .realPath(root)
    .pipe(Effect.orElseSucceed(() => root));
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) {
    yield* Effect.logWarning("proposal path resolves outside its scope", {
      path: input.proposal.path,
      proposalId: input.proposal.id,
    });
    return yield* refuse();
  }

  yield* fs.writeFileString(target, input.proposal.body).pipe(Effect.orDie);
  return relative(realRoot, target);
});

/** A task's proposals, newest first — decided ones included, because the answer is the record. */
export const listTaskProposals = Effect.fn("Gateway.proposals.list")(function* (
  input: ProposalRequest
) {
  yield* requireTask(input);
  const proposals = yield* ProposalRepo;
  return yield* proposals
    .listByTask({
      taskId: input.taskId,
      workspaceId: input.principal.workspaceId,
    })
    // Nothing a caller supplied can make a listing fail: a task with no
    // proposals is an empty array, and what is left is the driver or a row
    // that stopped decoding.
    .pipe(Effect.orDie);
});

/**
 * Accepts one proposal: writes the recorded body into the scope it names, then
 * records the decision.
 *
 * Bytes first, row second, on the same reasoning as a promotion. A row claiming
 * an accepted proposal whose file is not there reads to every later run as an
 * absence, while bytes with no row are a decision somebody can simply make
 * again — and the second attempt writes the same bytes over the same path.
 *
 * The state is checked here as well as under the store's row lock. That check is
 * the authority; this one is what stops a doomed call writing into a shared
 * directory every run reads.
 */
export const confirmProposal = Effect.fn("Gateway.proposals.confirm")(
  function* (input: ProposalItemRequest) {
    const decidedBy = yield* deciderOf(input.principal);
    const row = yield* requireOwnProposal(input);
    if (row.state !== "pending") {
      return yield* Effect.fail(
        new ProposalAlreadyDecided({ proposalId: row.id, state: row.state })
      );
    }

    const dir = yield* scopeDirOf({ dataRoot: input.dataRoot, proposal: row });
    // The folder is created on demand everywhere else in this system, and a
    // proposal into a project nobody has written to yet is the ordinary first
    // case rather than an error.
    yield* ensureArtifactDir({
      dataRoot: input.dataRoot,
      location:
        row.scope === "workspace" || row.projectId === null
          ? { scope: "global" }
          : { projectId: row.projectId, scope: "project" },
    }).pipe(Effect.orDie);
    const written = yield* writeIntoScope({ dir, proposal: row });

    const proposals = yield* ProposalRepo;
    const accepted = yield* proposals
      .accept({
        decidedBy,
        id: row.id,
        workspaceId: input.principal.workspaceId,
      })
      .pipe(withActor(input.principal.actor), asDecisionFailure);

    yield* Effect.annotateCurrentSpan({ path: written, scope: row.scope });
    return accepted;
  }
);

/** Records that a person refused it. Nothing is written anywhere else. */
export const rejectProposal = Effect.fn("Gateway.proposals.reject")(function* (
  input: ProposalItemRequest
) {
  const decidedBy = yield* deciderOf(input.principal);
  const row = yield* requireOwnProposal(input);
  const proposals = yield* ProposalRepo;
  const rejected = yield* proposals
    .reject({
      decidedBy,
      id: row.id,
      workspaceId: input.principal.workspaceId,
    })
    .pipe(withActor(input.principal.actor), asDecisionFailure);
  yield* Effect.annotateCurrentSpan({ scope: row.scope });
  return rejected;
});

/** The `proposals` group: the list, and the two answers a person can give. */
export const proposalsHandlers = HttpApiBuilder.group(
  Api,
  "proposals",
  (handlers) =>
    Effect.gen(function* () {
      // At build time, not per request: a mistyped DATA_ROOT should stop the
      // process rather than surface as a 500 on the first confirm.
      const dataRoot = yield* Effect.orDie(dataRootConfig);
      const on = yield* atBuild<FileSystem | ProposalRepo | TaskRepo>();

      return handlers.handleAll({
        confirm: ({ params }) =>
          on(
            Effect.flatMap(Principal, (principal) =>
              confirmProposal({
                dataRoot,
                principal,
                proposalId: params.proposalId,
                taskId: params.taskId,
              })
            )
          ),
        list: ({ params }) =>
          on(
            Effect.flatMap(Principal, (principal) =>
              listTaskProposals({ dataRoot, principal, taskId: params.taskId })
            )
          ),
        reject: ({ params }) =>
          on(
            Effect.flatMap(Principal, (principal) =>
              rejectProposal({
                dataRoot,
                principal,
                proposalId: params.proposalId,
                taskId: params.taskId,
              })
            )
          ),
      });
    })
);
