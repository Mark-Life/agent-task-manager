/**
 * The requests a run made of the directories it could not write, and what a
 * person did about them.
 *
 * The one repository whose rows hold a document rather than an index of one,
 * and the exception is deliberate: the file a run wrote sits in a folder later
 * runs on the same task can rewrite, so bytes read back off disk at confirm
 * time are not necessarily the bytes anybody read. What is accepted is what was
 * recorded.
 *
 * Nothing here can write a proposal in any state but `pending`, and nothing can
 * move it out of a decided one. That pair is the whole of what the read-only
 * mount buys — a worker's write above its own task scope lands inert, and stays
 * inert until a person acts once.
 */

import type {
  ProjectId,
  ProposalPath,
  ProposalScope,
  ProposalState,
  RunId,
  TaskId,
  UserId,
  WorkspaceId,
} from "@workspace/domain";
import { newProposalId, ProposalId } from "@workspace/domain";
import { and, desc, eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { Database } from "../client";
import { decodeProposal, ProposalInsert, ProposalUpdate } from "../rows";
import { proposal } from "../schema/proposal";
import {
  auditCreate,
  audited,
  auditUpdate,
  changesOf,
  decodeMany,
  decodeOne,
  decodeWritten,
  encodeWrite,
  execute,
  firstRow,
  writer,
} from "./audit";

/** Nothing in here reads more than one row by id. */
const ONE = 1;

/** The table these rows live in, and what an error names them as. */
const ENTITY = "proposal";

/** A proposal is never addressed by id alone; every query names the workspace it belongs to. */
interface ProposalRef {
  readonly id: ProposalId;
  readonly workspaceId: WorkspaceId;
}

const refOf = (ref: ProposalRef) =>
  and(eq(proposal.workspaceId, ref.workspaceId), eq(proposal.id, ref.id));

/**
 * Somebody has already answered this.
 *
 * Refused rather than restamped, for the reason a second promotion is: an
 * accepted proposal has already been written into a shared scope and recorded
 * in that scope's git history, so a row that could be answered twice would
 * disagree with the commit that is its evidence.
 */
export class ProposalAlreadyDecided extends Schema.TaggedErrorClass<ProposalAlreadyDecided>()(
  "ProposalRepo.AlreadyDecided",
  { id: ProposalId, state: Schema.String }
) {}

/**
 * One proposal as the collector read it off disk. Every field comes from the
 * run: what it wants written, where, and which of its own files asked.
 */
export interface ProposalRecord {
  readonly body: string;
  /** The digest of {@link body}, which is what a re-collection recognises. */
  readonly contentHash: string;
  readonly path: ProposalPath;
  /** The project whose directory is targeted; null for the workspace scope. */
  readonly projectId: ProjectId | null;
  /** The run that raised it. Never absent here — a run is what collects. */
  readonly runId: RunId;
  readonly scope: ProposalScope;
  /** Where it was read from, relative to the task's own directory. */
  readonly sourcePath: string;
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}

/** Which proposal is being answered, and by whom. */
export interface ProposalDecision extends ProposalRef {
  /**
   * The person answering. Taken rather than read off the ambient actor, because
   * the column names a human and a caller with no human to name is not making
   * this decision.
   */
  readonly decidedBy: UserId;
}

const make = Effect.gen(function* () {
  const db = yield* Database;
  const write = writer(db);

  /** The row a file with these exact bytes already has, or null. */
  const existing = Effect.fnUntraced(function* (input: ProposalRecord) {
    const rows = yield* execute(
      "ProposalRepo.record",
      db
        .select()
        .from(proposal)
        .where(
          and(
            eq(proposal.workspaceId, input.workspaceId),
            eq(proposal.taskId, input.taskId),
            eq(proposal.sourcePath, input.sourcePath),
            eq(proposal.contentHash, input.contentHash)
          )
        )
        .limit(ONE)
    );
    const decoded = yield* decodeMany({
      decode: decodeProposal,
      entity: ENTITY,
      rows,
    });
    return decoded[0] ?? null;
  });

  /**
   * Records one proposal a run left behind, or answers with the row that was
   * already there.
   *
   * Recognised by the digest of the body rather than by the filename, because
   * the file is not deleted once it is read: it stays in the task's folder as
   * evidence, the artifact scan indexes it, and a rerun of the same task meets
   * it again. Identical bytes are the request already answered or already
   * waiting; edited bytes are a different request, which is the honest reading —
   * the run asked for something else.
   *
   * The pre-read is outside the transaction and is not a lock. Nothing races it:
   * one run works a task at a time and collection happens once, on that run's
   * teardown, in one fiber. Two collectors that somehow overlapped would collide
   * on the unique index and the loser's failure would cost that one proposal,
   * which is the same tolerance every other read of a run's leavings has.
   */
  const record = Effect.fn("ProposalRepo.record")(function* (
    input: ProposalRecord
  ) {
    yield* Effect.annotateCurrentSpan({
      scope: input.scope,
      taskId: input.taskId,
    });
    const already = yield* existing(input);
    if (already !== null) {
      return { proposal: already, recorded: false };
    }
    const values = yield* encodeWrite({
      entity: ENTITY,
      schema: ProposalInsert,
      value: {
        body: input.body,
        contentHash: input.contentHash,
        decidedAt: null,
        decidedBy: null,
        id: newProposalId(),
        path: input.path,
        projectId: input.projectId,
        runId: input.runId,
        scope: input.scope,
        sourcePath: input.sourcePath,
        // Not a parameter, and there is no way to pass another: a proposal
        // exists in order to be inert.
        state: "pending",
        taskId: input.taskId,
        workspaceId: input.workspaceId,
      },
    });
    const created = yield* write(({ tx }) =>
      Effect.gen(function* () {
        const rows = yield* execute(
          "ProposalRepo.record",
          tx.insert(proposal).values(values).returning()
        );
        const row = yield* decodeWritten({
          decode: decodeProposal,
          entity: ENTITY,
          operation: "ProposalRepo.record",
          rows,
        });
        return audited(
          row,
          auditCreate({
            entityId: row.id,
            entityType: ENTITY,
            taskId: row.taskId,
            workspaceId: row.workspaceId,
          })
        );
      })
    );
    return { proposal: created, recorded: true };
  });

  /**
   * Moves one pending proposal to its answer, under a row lock.
   *
   * The lock and the re-read are what make "already decided" an answer rather
   * than a race: two people looking at the same list, or one clicking twice,
   * would both otherwise pass a check made before the update.
   */
  const decide = (state: Extract<ProposalState, "accepted" | "rejected">) =>
    Effect.fnUntraced(function* (input: ProposalDecision) {
      const operation = `ProposalRepo.${state}`;
      const decidedAt = yield* DateTime.now;
      const values = yield* encodeWrite({
        entity: ENTITY,
        schema: ProposalUpdate,
        value: { decidedAt, decidedBy: input.decidedBy, state },
      });
      return yield* write(({ tx }) =>
        Effect.gen(function* () {
          const locked = yield* execute(
            operation,
            tx
              .select()
              .from(proposal)
              .where(refOf(input))
              .limit(ONE)
              .for("update")
          );
          const before = yield* firstRow({
            entity: ENTITY,
            id: input.id,
            rows: locked,
          });
          if (before.state !== "pending") {
            return yield* Effect.fail(
              new ProposalAlreadyDecided({ id: input.id, state: before.state })
            );
          }
          const written = yield* execute(
            operation,
            tx.update(proposal).set(values).where(refOf(input)).returning()
          );
          const after = yield* decodeWritten({
            decode: decodeProposal,
            entity: ENTITY,
            operation,
            rows: written,
          });
          return audited(
            after,
            auditUpdate({
              changes: changesOf({ after: values, before }),
              entityId: after.id,
              entityType: ENTITY,
              taskId: after.taskId,
              workspaceId: after.workspaceId,
            })
          );
        })
      );
    });

  /**
   * Records that a person accepted it. The bytes are written into the shared
   * scope first, by the caller: a row claiming an accepted proposal whose file
   * is not there reads to every later run as an absence, while bytes with no row
   * are a decision somebody can simply make again.
   */
  const accept = Effect.fn("ProposalRepo.accept")(function* (
    input: ProposalDecision
  ) {
    yield* Effect.annotateCurrentSpan({ proposalId: input.id });
    return yield* decide("accepted")(input);
  });

  /** Records that a person refused it. Nothing is written anywhere else. */
  const reject = Effect.fn("ProposalRepo.reject")(function* (
    input: ProposalDecision
  ) {
    yield* Effect.annotateCurrentSpan({ proposalId: input.id });
    return yield* decide("rejected")(input);
  });

  /** One proposal, for the panel that shows its body and the two buttons beside it. */
  const byId = Effect.fn("ProposalRepo.byId")(function* (input: ProposalRef) {
    yield* Effect.annotateCurrentSpan({ proposalId: input.id });
    const rows = yield* execute(
      "ProposalRepo.byId",
      db.select().from(proposal).where(refOf(input)).limit(ONE)
    );
    return yield* decodeOne({
      decode: decodeProposal,
      entity: ENTITY,
      id: input.id,
      rows,
    });
  });

  /**
   * A task's proposals, newest first. Decided ones are included, because the
   * answer is as much of the record as the request — a list that hid them would
   * make an accepted rule change look like something nobody ever asked for.
   */
  const listByTask = Effect.fn("ProposalRepo.listByTask")(function* (input: {
    readonly taskId: TaskId;
    readonly workspaceId: WorkspaceId;
  }) {
    yield* Effect.annotateCurrentSpan({ taskId: input.taskId });
    const rows = yield* execute(
      "ProposalRepo.listByTask",
      db
        .select()
        .from(proposal)
        .where(
          and(
            eq(proposal.workspaceId, input.workspaceId),
            eq(proposal.taskId, input.taskId)
          )
        )
        .orderBy(desc(proposal.createdAt), desc(proposal.id))
    );
    return yield* decodeMany({
      decode: decodeProposal,
      entity: ENTITY,
      rows,
    });
  });

  return { accept, byId, listByTask, record, reject } as const;
});

/** What a run asked for above its own scope, and the decision that answered it. */
export class ProposalRepo extends Context.Service<
  ProposalRepo,
  Effect.Success<typeof make>
>()("@workspace/db/ProposalRepo") {
  static readonly layer = Layer.effect(ProposalRepo, make);
}
