import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { PR_STATE_LABEL, type PrState, parsePrUrl } from "@workspace/domain";
import { cn } from "@workspace/ui/lib/utils";

/**
 * What a card's pull request is doing, drawn the way GitHub draws it.
 *
 * The shape and the colour are the message, and both are borrowed rather than
 * invented: a person who has ever looked at a pull request already knows the
 * purple merge arrow and the red closed one, so the icon needs no legend and
 * the words are only there for the reader who wants them or cannot see colour.
 *
 * One component for both places it appears — the card in the column and the
 * open task — because they are the same claim about the same row, and two of
 * these would eventually disagree about which shade of green means open.
 *
 * With no state known it draws the plain outline icon it drew before any of
 * this existed. That is the honest picture for all three ways a state can be
 * missing: a card whose link has never been read, one whose repository this
 * board's credential cannot see, and one pointing at something that is not a
 * GitHub pull request at all.
 */

/** The four icons, and the fifth for a pull request nothing is known about. */
const STATE_ICON = {
  closed: GitPullRequestClosedIcon,
  draft: GitPullRequestDraftIcon,
  merged: GitMergeIcon,
  open: GitPullRequestIcon,
} as const satisfies Record<PrState, unknown>;

/**
 * The colour per state, as a class rather than a style so both themes are one
 * token away. The variables behind these are GitHub's own; see
 * `packages/ui/src/styles/globals.css`.
 */
const STATE_CLASS = {
  closed: "text-pr-closed",
  draft: "text-pr-draft",
  merged: "text-pr-merged",
  open: "text-pr-open",
} as const satisfies Record<PrState, string>;

/**
 * The pull request's number, when the link is one this can read.
 *
 * Null covers a link to something else entirely, which is a thing `pr_url` can
 * hold — it is free text three writers put values in.
 */
export const prNumberOf = (prUrl: string): number | null => {
  const ref = parsePrUrl(prUrl);
  return ref === null ? null : ref.number;
};

/**
 * The words the icon stands for: the state and the number, or just the number
 * for a pull request whose state is not known.
 *
 * This is what the tooltip carries and what a screen reader reads, so it is a
 * sentence rather than a fragment — "pull request #75, merged" is an answer and
 * "merged" beside an unlabelled link is not.
 */
export const prStateTitle = (input: {
  readonly prState: PrState | null;
  readonly prUrl: string;
}) => {
  const number = prNumberOf(input.prUrl);
  const named = number === null ? "Pull request" : `Pull request #${number}`;
  return input.prState === null
    ? named
    : `${named}, ${PR_STATE_LABEL[input.prState]}`;
};

/** The short form beside the icon on a card: the state, or `PR` when there is none. */
export const prStateLabel = (prState: PrState | null) =>
  prState === null ? "PR" : PR_STATE_LABEL[prState];

/**
 * The longer form for the open task, where there is room for the number.
 *
 * `#75 merged` rather than `Pull request #75, merged`: the icon beside it has
 * already said which kind of thing this is, and the full sentence is on the
 * tooltip for whoever wants it. A link this cannot read the number out of keeps
 * the words instead, since `#` on its own says nothing.
 */
export const prStateNumbered = (input: {
  readonly prState: PrState | null;
  readonly prUrl: string;
}) => {
  const number = prNumberOf(input.prUrl);
  if (number === null) {
    return input.prState === null
      ? "Pull request"
      : `Pull request, ${PR_STATE_LABEL[input.prState]}`;
  }
  return input.prState === null
    ? `Pull request #${number}`
    : `#${number} ${PR_STATE_LABEL[input.prState]}`;
};

/**
 * The icon alone. `title` is not set here — the anchor around it carries the
 * whole sentence, so a pointer resting on the link gets one tooltip rather than
 * two competing ones.
 */
export const PrStateIcon = ({
  className,
  prState,
}: {
  readonly className?: string;
  readonly prState: PrState | null;
}) => (
  <HugeiconsIcon
    className={cn(
      "shrink-0",
      prState === null ? undefined : STATE_CLASS[prState],
      className
    )}
    icon={prState === null ? GitPullRequestIcon : STATE_ICON[prState]}
    strokeWidth={2}
  />
);
