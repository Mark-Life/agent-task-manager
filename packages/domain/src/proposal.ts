/**
 * A change a worker wants made to a directory it cannot write, and a person's
 * decision about it.
 *
 * A worker clones arbitrary repositories. One that writes the house rules after
 * reading a hostile README has changed every later run on every project, so its
 * workspace scope is a read-only mount and the flag is what makes that true —
 * a sentence in a prompt only asks. What the flag takes away this gives back:
 * the run writes a file in the one directory it owns, the loop reads it after
 * the container is gone, and the change sits inert until somebody accepts it.
 *
 * **The medium is a file, because a file is the one thing a run can always
 * do.** No tool, no credential, no network — the same reasoning as
 * {@link HANDOFF_FILENAME}, and the same tolerance: a malformed proposal costs
 * that proposal and never the run.
 *
 * **The row is the proposal, not the file.** The file stays where it was
 * written, in a folder later runs on the same task can rewrite, so a confirm
 * that read the disk again would let a run swap the bytes between the moment a
 * person read them and the moment they accepted. {@link Proposal.body} is what
 * is written when they do.
 *
 * **A decision is recorded, never a row rewritten into a different proposal.**
 * The state moves once, from pending, and what lands on disk is recorded by the
 * shared scope's own git history — `@workspace/sandbox`'s history snapshots
 * both shared scopes around every run, so the commit is the audit trail and
 * there is no second one here.
 */

import { Schema } from "effect";
import { ProjectId, ProposalId, RunId, TaskId, UserId } from "./ids";
import { recordFields, Timestamp } from "./primitives";
import { relativePathFilter } from "./relative-path";

/**
 * Where a worker writes a proposal, relative to its own task directory.
 *
 * A directory rather than a single filename, because one run may have more than
 * one thing to propose and a single name would make the second overwrite the
 * first. Dotted, so the ordinary contents of a task folder — the run's output,
 * the thing a person opens — are not mixed in with its requests.
 *
 * Named here rather than in the orchestrator or in the prompts because two
 * packages have to agree on it and neither owns the other: `@workspace/prompts`
 * tells the agent where to write, `@workspace/orchestrator` reads it back, and
 * a second spelling in either is a proposal nobody collects.
 */
export const PROPOSALS_DIRNAME = ".atm/proposals";

/**
 * The two directories a proposal can target, which are exactly the two scopes
 * shared between runs.
 *
 * The task scope is absent and cannot be added: a run writes it directly, so a
 * proposal there would be a request to do something already done. The checkout
 * is absent for the opposite reason — that is what a pull request is for, and it
 * has a reviewer already.
 *
 * The words are the ones `@workspace/sandbox`'s history uses for the same two
 * directories, rather than the `global` the artifact index calls the first: this
 * is the name a worker writes into a file, and the directory it knows is the
 * workspace it is nested inside.
 */
export const PROPOSAL_SCOPES = ["workspace", "project"] as const;

/** Which shared directory a proposal is about. */
export const ProposalScope = Schema.Literals(PROPOSAL_SCOPES);
export type ProposalScope = typeof ProposalScope.Type;

/**
 * Where a proposal stands. `pending` is inert and is the only state a run can
 * cause; the other two are a person's answer and are terminal, because a
 * decision that could be taken back would make the git history of the scope
 * disagree with the row that claims to describe it.
 */
export const PROPOSAL_STATES = ["pending", "accepted", "rejected"] as const;

/** Whether a proposal is waiting, was written, or was refused. */
export const ProposalState = Schema.Literals(PROPOSAL_STATES);
export type ProposalState = typeof ProposalState.Type;

/**
 * The most a proposal may carry, in bytes: sixty-four kibibytes.
 *
 * A bound rather than none, because this is the one place a run's own text
 * lands in a column rather than on disk, and an agent that decides to propose
 * its entire checkout should be refused by the table rather than by the backup
 * that got slower. Far above any rules document and far below the size at which
 * a file wanted a pull request instead.
 */
export const PROPOSAL_BODY_MAX_BYTES = 65_536;

/**
 * The file a proposal is written into, relative to the scope it targets.
 *
 * Branded off the shared rule, so a path that climbs with `..`, starts at the
 * root, or reaches into the scope's own `.git` cannot be joined to a directory
 * — which is the whole injection this design exists to refuse, since the
 * proposal's text arrives from a run that read an untrusted repository.
 */
export const ProposalPath = Schema.String.pipe(
  Schema.check(relativePathFilter("scope-relative path")),
  Schema.brand("ProposalPath")
);
export type ProposalPath = typeof ProposalPath.Type;

/**
 * One pending or decided change to a shared directory.
 *
 * It names both ends of its own story: the task and run that raised it, so a
 * reader can ask what the agent was doing when it asked, and who decided it and
 * when, so nobody has to join the audit log to answer the question the row is
 * about.
 */
export const Proposal = Schema.Struct({
  ...recordFields,
  /** The whole proposed contents of the target file. Written verbatim on accept. */
  body: Schema.String,
  /**
   * The digest of {@link body}, which is what makes collection idempotent: the
   * file is not deleted after it is read, so a rerun of the same task meets it
   * again, and a proposal already recorded byte for byte is not a second
   * decision for somebody to make.
   */
  contentHash: Schema.String,
  /** When a person answered, and null while it is still pending. */
  decidedAt: Schema.NullOr(Timestamp),
  /**
   * The person who answered. A user rather than a flattened actor, because the
   * route that decides is admin-scoped and no agent's credential can ever reach
   * it — so the column can say what is true rather than what is possible.
   */
  decidedBy: Schema.NullOr(UserId),
  id: ProposalId,
  /** Where in the scope the file goes. */
  path: ProposalPath,
  /** The project whose directory is targeted, and null for a workspace proposal. */
  projectId: Schema.NullOr(ProjectId),
  /** The run that raised it. Null once that run has been erased; the task remains. */
  runId: Schema.NullOr(RunId),
  scope: ProposalScope,
  /**
   * Where the proposal was read from, relative to the task's own directory, so
   * a person looking at the row can open the file the agent actually wrote.
   */
  sourcePath: Schema.String,
  state: ProposalState,
  /** The task whose run raised it. Every proposal has one — only a worker proposes. */
  taskId: TaskId,
});

export interface Proposal extends Schema.Schema.Type<typeof Proposal> {}
