/**
 * The shapes every prompt is built out of, whichever role reads it.
 *
 * A prompt in this system is always the same three things in the same order:
 * standing rules, the conversation the run has not yet seen, and the paths it
 * was given. What changes between a worker and a manager is the wording of the
 * rules and how one line of conversation is attributed — not the assembly. So
 * the assembly lives here once, and each role supplies only its own text.
 *
 * Everything in this module is pure and total: strings in, strings out, no
 * clock, no database, no config. That is what lets the whole composition be
 * asserted in a unit test.
 */

/** Drops the sections a run did not earn and joins what is left. */
export const joinSections = (sections: readonly (string | null)[]) =>
  sections.filter((part) => part !== null).join("\n\n");

/** A titled block, or null when there is nothing to put in it. */
export const section = (title: string, body: string | null) =>
  body === null || body.trim().length === 0 ? null : `## ${title}\n${body}`;

/** One utterance: who said it, and what they said. */
export interface SpeechInput {
  readonly body: string;
  /**
   * What separates the label from the words. A comment runs to paragraphs and
   * reads better on its own line; a chat line is one sentence and reads as
   * dialogue.
   */
  readonly gap?: "line" | "space";
  /** The speaker, ending in the punctuation that leads into the body. */
  readonly label: string;
}

/** One utterance, rendered. The body is trimmed so a stored newline is not a section break. */
export const speech = ({ body, gap = "line", label }: SpeechInput) =>
  `${label}${gap === "line" ? "\n" : " "}${body.trim()}`;

/** A run of utterances, oldest first, blank line between speakers. */
export const conversation = (lines: readonly string[]) => lines.join("\n\n");

/**
 * The directories a run can see, named as the run itself sees them.
 *
 * Not the container constants directly, because the local sandbox runs the same
 * spec as a plain subprocess and rewrites every container path back to the host
 * path its mount pointed at. A prompt that named `/artifacts/task` in that mode
 * would send the agent to write into a directory that does not exist — the one
 * failure that looks like a run that produced nothing.
 */
export interface RunPlacement {
  /** The run's own artifacts folder. The only artifacts folder it may write. */
  readonly artifactsDir: string;
  /** The branch the checkout is on, or null for a run with no repo. */
  readonly branch: string | null;
  /** The global promoted folder, read-only. */
  readonly globalArtifactsDir: string;
  /** The project's promoted folder, read-only, or null when there is no project. */
  readonly projectArtifactsDir: string | null;
  /** The repo checkout, or the scratch directory a run with no repo gets. */
  readonly workspaceDir: string;
}

/** What a placement is rendered from: the directories, and whether there is a repo in them. */
export interface PlacementSectionInput {
  readonly placement: RunPlacement;
  readonly repoUrl: string | null;
}

/**
 * Where the run works, as a list of paths and nothing else.
 *
 * The policy about those paths — which one is writable, what happens to
 * everything outside them — is in {@link SHARED_RULES}, stated once. This
 * section only says which directory is which, because the paths change per run
 * and the policy does not.
 */
export const placementSection = ({
  placement,
  repoUrl,
}: PlacementSectionInput) => {
  // A run whose only writable directory *is* its scratch directory has nothing
  // promoted out of it, so saying what it leaves there outlives the container
  // would be false — and saying it on a second line about the same path would
  // be false twice.
  const scratchIsWritable = placement.artifactsDir === placement.workspaceDir;
  const lines = [
    repoUrl === null
      ? `- \`${placement.workspaceDir}\` is an empty scratch directory${scratchIsWritable ? ", yours to write, released when this run ends" : ""}. This run has no repo.`
      : `- \`${repoUrl}\` is cloned at \`${placement.workspaceDir}\`${placement.branch === null ? "" : `, on branch \`${placement.branch}\``}. Push that branch and open a pull request when the work is ready.`,
    ...(scratchIsWritable
      ? []
      : [
          `- \`${placement.artifactsDir}\` is yours to write, and what you leave there outlives the container.`,
        ]),
    placement.projectArtifactsDir === null
      ? `- Read-only reference material: \`${placement.globalArtifactsDir}\`.`
      : `- Read-only reference material: \`${placement.projectArtifactsDir}\` (this project) and \`${placement.globalArtifactsDir}\`.`,
  ];
  return lines.join("\n");
};

/**
 * Which shape a session gets. A fresh session is situated from nothing; a
 * resumed one already holds all of that in its own history and is told only
 * what has arrived since.
 */
export type PromptMode = "fresh" | "resumed";

/** A run's prompt, and its length. Measured here so nothing downstream measures it differently. */
export interface RunPrompt {
  /** What `promptChars` on the run's events and its wide event carry. */
  readonly chars: number;
  readonly text: string;
}

/** The prompt text, with the one measurement telemetry takes of it. */
export const promptOf = (text: string): RunPrompt => ({
  chars: text.length,
  text,
});
