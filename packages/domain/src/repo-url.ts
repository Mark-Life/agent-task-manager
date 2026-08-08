/**
 * What counts as a repository URL, decided once.
 *
 * This lived in `@workspace/sandbox` beside the checkout machinery, which is
 * the only place that acts on it — and is a package the dashboard cannot load,
 * since it reaches for Bun's filesystem and spawns git. So a browser wanting to
 * tell somebody *before* they save that a URL will never clone had to restate
 * the rule, and a restated rule is two rules: the day one learns about a new
 * form the other refuses it, and the form field and the run disagree about the
 * same string. It sits here instead, in the package both sides already depend
 * on, and the sandbox reads it from here.
 */

/** A URL with a scheme, as opposed to the `git@host:owner/name` shorthand. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The `[user@]host:path` form ssh remotes are usually written in. */
const SCP_RE = /^(?:[^@/]+@)?([^:/]+):(.+)$/;

/** `owner/name`, with an optional `.git` suffix and trailing slash. */
const OWNER_NAME_RE = /^\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

/** One path segment of a mirror directory: no slashes, no leading dot. */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A single trailing slash, which a pasted URL usually has and a remote never wants. */
const TRAILING_SLASH_RE = /\/$/;

/**
 * The form this system writes down, and the one a field offering an example
 * should show. Every other form {@link parseRepoUrl} accepts still clones —
 * this is what a person with nothing pasted yet should be nudged towards, not
 * a rule.
 */
export const CANONICAL_REPO_URL_EXAMPLE = "https://github.com/owner/repo";

/**
 * A repo, taken apart. `slug` is what a failure and a span are named after —
 * `owner/name` carries no credential, which {@link RepoIdentity.cloneUrl} may.
 */
export interface RepoIdentity {
  /** The URL as given, minus a trailing slash. Fed to git, never to a log. */
  readonly cloneUrl: string;
  /** Lowercased, because a hostname is case-insensitive and a directory is not. */
  readonly host: string;
  readonly name: string;
  readonly owner: string;
  /** `owner/name`. Safe to put on an event. */
  readonly slug: string;
}

/** The host and `owner/name` path of a remote, in whichever form it was written. */
const splitRemote = (raw: string) => {
  if (SCHEME_RE.test(raw)) {
    try {
      const url = new URL(raw);
      return { host: url.hostname, path: url.pathname };
    } catch {
      return null;
    }
  }
  const scp = SCP_RE.exec(raw);
  return scp === null ? null : { host: scp[1] ?? "", path: scp[2] ?? "" };
};

/**
 * Takes a clone URL apart, or answers null for anything that is not one.
 *
 * Total and pure, and null rather than a guess: a project whose repo field
 * holds prose or a bare name would otherwise become a mirror directory named
 * after that prose and a clone that fails much later, against a path nobody can
 * trace back to what was typed. Every host is accepted — GitHub is what this
 * runs against today, and rejecting the others would be a check that only
 * catches the honest cases.
 */
export const parseRepoUrl = (raw: string): RepoIdentity | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const split = splitRemote(trimmed);
  if (split === null || split.host.length === 0) {
    return null;
  }
  const match = OWNER_NAME_RE.exec(split.path);
  const owner = match?.[1];
  const name = match?.[2];
  if (
    owner === undefined ||
    name === undefined ||
    !(SEGMENT_RE.test(owner) && SEGMENT_RE.test(name))
  ) {
    return null;
  }
  return {
    cloneUrl: trimmed.replace(TRAILING_SLASH_RE, ""),
    host: split.host.toLowerCase(),
    name,
    owner,
    slug: `${owner}/${name}`,
  };
};

/**
 * Whether a repository field holds something a run could clone.
 *
 * Empty is true, and that is the point of having this as well as
 * {@link parseRepoUrl}: a project with no repository is an ordinary project, so
 * a blank box is a complete answer rather than a mistake, and a validator that
 * treated it as one would make the field required by the back door.
 */
export const isCloneableRepoUrl = (raw: string) =>
  raw.trim() === "" || parseRepoUrl(raw) !== null;
