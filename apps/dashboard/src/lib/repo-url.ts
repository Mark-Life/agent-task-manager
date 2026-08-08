import {
  CANONICAL_REPO_URL_EXAMPLE,
  isCloneableRepoUrl,
} from "@workspace/domain";

/**
 * What a repository box says before anything is typed into it, and what it says
 * when what was typed will not clone.
 *
 * The rule is not restated here. {@link isCloneableRepoUrl} is the same
 * function the host calls when it materializes a checkout, so a box that
 * accepts a URL and a run that clones it cannot disagree — which is the whole
 * reason it moved into `@workspace/domain`. This module is the wording around
 * it and nothing else.
 *
 * The field advertised the `git@github.com:owner/repo.git` shorthand for a
 * while, which was the wrong example rather than a wrong rule. That form parses
 * and clones, so refusing it here would be the client contradicting the server.
 * It is a poor thing to recommend all the same: a run's `origin` is set to the
 * URL exactly as written, the only credential in the checkout is an https token
 * helper, and the container mounts no `~/.ssh` — so an ssh remote is a run that
 * gets its files and then cannot push what it did with them. Hence an https
 * example and a rule no narrower than the checkout's.
 */
export const REPO_URL_PLACEHOLDER = CANONICAL_REPO_URL_EXAMPLE;

/**
 * The problem with this repository URL, or null when there is none.
 *
 * Empty is not a problem. A project with no repository is an ordinary project
 * — its runs get a scratch directory — so a blank box must never be what stops
 * a form from being sent.
 */
export const repoUrlProblem = (value: string): string | null =>
  isCloneableRepoUrl(value)
    ? null
    : `That is not a clone URL. Use the form ${REPO_URL_PLACEHOLDER} — the git@github.com:owner/repo.git shorthand is accepted too, but a bare owner/repo or a link to a page inside the repo is not.`;
