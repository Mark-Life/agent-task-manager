/**
 * The changes a run asked for in a directory it could not write, read back off
 * the disk it could.
 *
 * **A worker's workspace scope is a read-only mount, and that flag is the whole
 * design.** A run clones arbitrary repositories, so one that writes the house
 * rules after reading a hostile README would have changed every later run on
 * every project. A rule in a prompt asks; a mount flag decides. What this module
 * gives back is the one door through the flag: the run writes a file in the
 * directory it does own, the loop reads it once the container is gone, and the
 * change sits pending and inert until a person accepts it.
 *
 * **The file is the medium because a file is the one thing a run can always
 * do.** No tool, no credential, no network — the same reasoning as
 * `./handoff`, and this module borrows that module's tolerance wholesale: a
 * proposal that cannot be read, cannot be parsed, or names a path that climbs
 * out of its scope costs that proposal and never the run. Everything here runs
 * on the teardown path of a run that has already ended.
 *
 * **A refused path is the injection this whole design exists to stop.** The
 * front matter arrives from a model that has read an untrusted repository, so
 * `..`, a leading `/` and a `.git` segment are refusals rather than something to
 * normalize — see `relativePathRefusalOf` in `@workspace/domain`, which is the
 * same rule an environment file's path goes through and for the same reason.
 * Each refusal is logged with the file that carried it, because a proposal that
 * vanishes silently is indistinguishable from a run that proposed nothing.
 *
 * **Nothing is deleted after it is read.** The file stays in the task's folder,
 * the artifact scan indexes it, and a person reading the row can open what the
 * agent actually wrote. Re-collection is made harmless by the store instead:
 * `ProposalRepo.record` recognises the same bytes from the same file and
 * records nothing.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { ProposalRepo, withActor } from "@workspace/db";
import {
  PROPOSAL_BODY_MAX_BYTES,
  PROPOSAL_SCOPES,
  PROPOSALS_DIRNAME,
  type ProposalPath,
  type ProposalScope,
  relativePathRefusalOf,
  type TaskId,
} from "@workspace/domain";
import { taskArtifactsDirOf } from "@workspace/sandbox";
import { Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
  type DispatchContext,
  projectIdOf,
  taskIdOf,
  workspaceIdOf,
} from "./dispatch-context";

/** Only markdown is read, so a stray note beside a proposal is not one. */
const PROPOSAL_SUFFIX = ".md";

/** What opens and closes the front matter. The convention every static site generator taught. */
const FENCE = "---";

/** The two keys a proposal has to carry, spelled as the prompt spells them. */
const SCOPE_KEY = "scope";
const PATH_KEY = "path";

/** The algorithm prefix on a recorded digest, so it can change later without ambiguity. */
const CONTENT_HASH_ALGORITHM = "sha256";

/**
 * Why a file in the proposals directory is not a proposal. A closed set, so the
 * log line is a value an operator can count rather than a sentence.
 */
export const PROPOSAL_REFUSALS = [
  "no_front_matter",
  "unterminated_front_matter",
  "missing_scope",
  "unknown_scope",
  "missing_path",
  "bad_path",
  "empty_body",
  "too_large",
  "no_project",
] as const;

/** What was wrong with one proposal file. */
export type ProposalRefusal = (typeof PROPOSAL_REFUSALS)[number];

/** What a run asked for, once the file it wrote has been read and believed. */
export interface ParsedProposal {
  /** The whole proposed contents of the target file. */
  readonly body: string;
  /** Where in the scope it goes. Checked, which is what the brand records. */
  readonly path: ProposalPath;
  readonly scope: ProposalScope;
}

/** A parsed proposal, or the reason the file is not one. Total over any bytes. */
export type ProposalParse =
  | { readonly kind: "proposal"; readonly proposal: ParsedProposal }
  | { readonly kind: "refused"; readonly refusal: ProposalRefusal };

const refused = (refusal: ProposalRefusal): ProposalParse => ({
  kind: "refused",
  refusal,
});

/**
 * One `key: value` line of front matter, or nothing where the line carries
 * none. Quotes are stripped because a model writing YAML quotes about half the
 * time, and a path that arrives wrapped in quotation marks is a path that fails
 * every check for a reason nobody can see.
 */
const entryOf = (line: string) => {
  const at = line.indexOf(":");
  if (at === -1) {
    return null;
  }
  const key = line.slice(0, at).trim().toLowerCase();
  const value = line
    .slice(at + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
  return key.length === 0 ? null : ([key, value] as const);
};

/** Whether a string is one of the two scopes, narrowing rather than asserting. */
const isScope = (value: string): value is ProposalScope =>
  PROPOSAL_SCOPES.includes(value as ProposalScope);

/**
 * Splits the front matter from the body.
 *
 * Line-based rather than regular-expression based, and tolerant of a leading
 * blank line and of either line ending, because the file was written by a model
 * with a text editor tool and not by a serializer. What it is not tolerant of is
 * a missing fence: a file with no front matter names no target, and a proposal
 * with no target is a document somebody would have to guess about.
 */
const splitFrontMatter = (text: string) => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < lines.length && lines[start]?.trim() === "") {
    start += 1;
  }
  if (lines[start]?.trim() !== FENCE) {
    return null;
  }
  for (let end = start + 1; end < lines.length; end += 1) {
    if (lines[end]?.trim() === FENCE) {
      return {
        body: lines.slice(end + 1).join("\n"),
        head: lines.slice(start + 1, end),
      };
    }
  }
  return { body: null, head: [] as readonly string[] };
};

/**
 * One proposal file, read as a value. Pure, and total over anything at all —
 * an empty file, a screenshot renamed to `.md`, front matter that never closes.
 *
 * The path is refused rather than repaired. Rewriting `../../CLAUDE.md` into
 * something inside the scope is how a checker and a writer come to disagree
 * about which file was meant, and this is the file where that disagreement is
 * an untrusted repository editing the rules of every later run.
 */
export const parseProposal = (text: string): ProposalParse => {
  if (text.length > PROPOSAL_BODY_MAX_BYTES) {
    return refused("too_large");
  }
  const split = splitFrontMatter(text);
  if (split === null) {
    return refused("no_front_matter");
  }
  if (split.body === null) {
    return refused("unterminated_front_matter");
  }
  const fields = new Map(
    split.head.map(entryOf).filter((entry) => entry !== null)
  );

  const scope = fields.get(SCOPE_KEY);
  if (scope === undefined || scope.length === 0) {
    return refused("missing_scope");
  }
  if (!isScope(scope)) {
    return refused("unknown_scope");
  }

  const path = fields.get(PATH_KEY);
  if (path === undefined || path.length === 0) {
    return refused("missing_path");
  }
  if (relativePathRefusalOf(path) !== null) {
    return refused("bad_path");
  }

  const { body } = split;
  // A file that is nothing but front matter proposes deleting the contents of
  // whatever it names, which is not something this shape can say. Read as an
  // agent that got as far as the header, exactly as an empty handoff is read as
  // a run that had nothing to say.
  if (body.trim().length === 0) {
    return refused("empty_body");
  }

  return {
    kind: "proposal",
    proposal: { body, path: path as ProposalPath, scope },
  };
};

/** Whose proposals to look for, and where the artifacts tree lives. */
export interface ProposalCollectionInput {
  /** The run directory's root, not the run's own — the artifact folders are its siblings. */
  readonly dataRoot: string;
  /** Whether the run had a project directory, which decides if it may propose into one. */
  readonly hasProject: boolean;
  readonly taskId: TaskId;
}

/** Where a task's proposals would be if it wrote any. */
export const proposalsDirOf = (input: {
  readonly dataRoot: string;
  readonly taskId: TaskId;
}) =>
  join(
    taskArtifactsDirOf({ dataRoot: input.dataRoot, taskId: input.taskId }),
    PROPOSALS_DIRNAME
  );

/** A proposal that was there, and the file it came out of. */
export interface CollectedProposal extends ParsedProposal {
  /** The digest of the body, which is what makes recording it twice a no-op. */
  readonly contentHash: string;
  /** Relative to the task's own directory, so a person can open what the agent wrote. */
  readonly sourcePath: string;
}

/** The digest a recorded proposal carries, algorithm prefix and all. */
const digestOf = (body: string) =>
  `${CONTENT_HASH_ALGORITHM}:${createHash(CONTENT_HASH_ALGORITHM).update(body).digest("hex")}`;

/**
 * Every proposal a run left, refusals logged and dropped.
 *
 * Total over a missing directory, an unreadable file and a file that is not a
 * proposal, for the reason the module note gives: this runs after the container
 * is gone, and a folder that cannot be read must not turn "there was nothing to
 * collect" into a run that failed to close.
 *
 * A proposal into a project's directory from a run that had no project
 * directory is refused here rather than at the store. The run is describing a
 * place it never had, so there is nothing to accept and nothing a person could
 * decide about — and the alternative is a row whose scope names a project the
 * task does not belong to.
 */
export const readProposals = Effect.fn("Ingest.proposals")(function* (
  input: ProposalCollectionInput
) {
  const fs = yield* FileSystem;
  const directory = proposalsDirOf(input);
  yield* Effect.annotateCurrentSpan({ directory, taskId: input.taskId });

  const present = yield* fs
    .exists(directory)
    .pipe(Effect.orElseSucceed(() => false));
  if (!present) {
    return [] as readonly CollectedProposal[];
  }

  const entries = yield* fs
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): readonly string[] => []));
  const files = entries.filter((entry) => entry.endsWith(PROPOSAL_SUFFIX));

  const collected = yield* Effect.forEach([...files].sort(), (file) =>
    Effect.gen(function* () {
      const sourcePath = join(PROPOSALS_DIRNAME, file);
      const text = yield* Effect.option(
        fs.readFileString(join(directory, file))
      );
      if (Option.isNone(text)) {
        yield* Effect.logWarning("proposal present but unreadable", {
          sourcePath,
        });
        return [];
      }
      const parsed = parseProposal(text.value);
      if (parsed.kind === "refused") {
        yield* Effect.logWarning("proposal refused", {
          refusal: parsed.refusal,
          sourcePath,
        });
        return [];
      }
      if (parsed.proposal.scope === "project" && !input.hasProject) {
        yield* Effect.logWarning("proposal refused", {
          refusal: "no_project" satisfies ProposalRefusal,
          sourcePath,
        });
        return [];
      }
      return [
        {
          ...parsed.proposal,
          contentHash: digestOf(parsed.proposal.body),
          sourcePath,
        } satisfies CollectedProposal,
      ];
    })
  );

  const proposals = collected.flat();
  yield* Effect.annotateCurrentSpan({ proposalCount: proposals.length });
  return proposals as readonly CollectedProposal[];
});

/** What one run's teardown collected. */
export interface ProposalCollectionReport {
  /** The directory that was walked, so a surprising count names a path a human can `ls`. */
  readonly directory: string;
  /** Proposals now waiting for a person because of this run. */
  readonly recorded: number;
  /** Files that parsed and were already recorded, byte for byte, by an earlier pass. */
  readonly seen: number;
}

/**
 * Reads a run's proposals and records the ones that are new.
 *
 * Attributed to the run that raised it, because that is what a person deciding
 * needs: a rule change is only as trustworthy as the work that asked for it,
 * and the run is the thread back to the repository it had cloned.
 *
 * A run attached to a conversation collects nothing and says so with a null.
 * The manager writes the shared scopes directly — it reads no untrusted
 * repository and it is the role a human is talking to — so a proposal from it
 * would be a hop with nobody new in the loop.
 */
export const collectRunProposals = Effect.fnUntraced(function* (input: {
  readonly context: DispatchContext;
  readonly dataRoot: string;
}) {
  const { context, dataRoot } = input;
  const taskId = taskIdOf(context);
  if (taskId === null) {
    return null;
  }
  const projectId = projectIdOf(context);
  const collected = yield* readProposals({
    dataRoot,
    hasProject: projectId !== null,
    taskId,
  });
  if (collected.length === 0) {
    return {
      directory: proposalsDirOf({ dataRoot, taskId }),
      recorded: 0,
      seen: 0,
    } satisfies ProposalCollectionReport;
  }

  const proposals = yield* ProposalRepo;
  const asRun = withActor(context.actor);
  const written = yield* Effect.forEach(collected, (proposal) =>
    asRun(
      proposals.record({
        body: proposal.body,
        contentHash: proposal.contentHash,
        path: proposal.path,
        projectId: proposal.scope === "project" ? projectId : null,
        runId: context.runId,
        scope: proposal.scope,
        sourcePath: proposal.sourcePath,
        taskId,
        workspaceId: workspaceIdOf(context),
      })
    ).pipe(
      // Per proposal, so one the store refuses — a body over the column's
      // bound, a task erased between the run and its teardown — costs that
      // proposal and not the rest of them.
      Effect.tapError((cause) =>
        Effect.logWarning("proposal not recorded", {
          cause,
          sourcePath: proposal.sourcePath,
        })
      ),
      Effect.orElseSucceed(() => null)
    )
  );

  return {
    directory: proposalsDirOf({ dataRoot, taskId }),
    recorded: written.filter((row) => row?.recorded === true).length,
    seen: written.filter((row) => row?.recorded === false).length,
  } satisfies ProposalCollectionReport;
});
