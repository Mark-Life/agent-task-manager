/**
 * A skill, as files: where the two copies of one skill live in a scope, what
 * the lock beside them records, and how a `SKILL.md` in somebody's repository
 * becomes those bytes.
 *
 * **There is no installer to run.** A skill is a directory holding a `SKILL.md`
 * and whatever that document refers to, and installing one is writing those
 * files where a provider looks. So this module fetches, hashes and compares;
 * the writing is the gateway's, which already owns the one containment check
 * every path into a scope goes through.
 *
 * **One copy, two names.** The real files sit at
 * `<scope>/{@link AGENT_SKILLS_DIR}/<name>` and
 * `<scope>/{@link CLAUDE_SKILLS_DIR}/<name>` is a symbolic link to them. Codex
 * reads the real path, Claude reads the link, and there is one directory to
 * edit rather than two copies that disagree the day somebody fixes a typo in
 * one. {@link skillLinkTargetOf} builds that link **relative** — both
 * directories sit at the same scope inside the same bind mount, so a relative
 * link resolves inside a container while an absolute one would name a host path
 * no container can see.
 *
 * **Claude does not read these, and saying otherwise in a comment or a button
 * would be a lie with a long life.** Claude's scan for project skills runs from
 * the working directory up to the repository root and stops there; a run's
 * working directory is the checkout, so every scope directory sits above the
 * stop. Verified live rather than read off a page. Codex has no such stop and
 * collects `.agents/skills` from every level, so scope-level skills reach Codex
 * today and Claude keeps reading the operator's personal skills at the
 * `/agent-home/skills` mount, exactly as before. The layout is still the right
 * one — Claude follows symlinked skill directories and deduplicates by target,
 * so the day a per-run skills directory is composed, nothing here changes.
 *
 * **The lock is the four fields the repository's own `skills-lock.json`
 * carries**, one file per scope: where the skill came from, what kind of source
 * that is, the path of the `SKILL.md` inside it, and a hash of what was
 * installed. Four fields and no more, because a fifth — a branch, a commit —
 * would be a thing this system stored and then had to keep true, and an update
 * is defined here as "ask the source again and compare", which needs none of
 * them.
 */

import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path/posix";
import {
  parseRepoUrl,
  relativePathRefusalOf,
  type SkillFileStatus,
  SkillLockEntry,
  type SkillName,
  type SkillSourcePath,
} from "@workspace/domain";
import { Effect, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { readGithubToken } from "./github";

/** Where the real files live, at every level of the tree. Codex's own path. */
export const AGENT_SKILLS_DIR = ".agents/skills";

/** Where the links live. Claude's path, kept in step for the day its scan reaches this far. */
export const CLAUDE_SKILLS_DIR = ".claude/skills";

/** The one file a skill must have. Its directory is the skill. */
export const SKILL_FILE = "SKILL.md";

/** What a scope records about the skills installed into it, at that scope's root. */
export const SKILLS_LOCK_FILE = "skills-lock.json";

/** The lock format this reads and writes. The repository's own file is version 1. */
export const SKILLS_LOCK_VERSION = 1;

/** The one host `api.github.com` answers for, so a mirror is refused rather than misread. */
const GITHUB_HOST = "github.com";

/** Where the REST API lives. A test points a fetch at its own server. */
export const GITHUB_CONTENTS_ORIGIN = "https://api.github.com";

/** Sent because GitHub rejects a request without one. */
const USER_AGENT = "agent-task-manager";

/** The REST version these shapes were read against. */
const API_VERSION = "2022-11-28";

/** Directory listings, which is the only shape this decodes. */
const CONTENTS_ACCEPT = "application/vnd.github+json";

/** One file's bytes, rather than the base64-in-JSON the same endpoint answers by default. */
const RAW_ACCEPT = "application/vnd.github.raw";

/**
 * How long the whole fetch of one skill gets.
 *
 * A skill is a handful of small files and this runs while a person waits on a
 * request, so the useful failure is "GitHub is not answering" arriving quickly
 * rather than a request that hangs until a proxy gives up on it.
 */
const FETCH_TIMEOUT = "30 seconds";

/**
 * How many files one skill may carry.
 *
 * A cap because the directory being fetched belongs to somebody else: a path
 * that names a directory of ten thousand files would otherwise be ten thousand
 * requests made by this process, with the operator's token, before anything
 * refused it.
 */
export const SKILL_MAX_FILES = 64;

/** The largest single file, one mebibyte. A skill is documents, not a dataset. */
export const SKILL_MAX_FILE_BYTES = 1_048_576;

/** The largest skill, four mebibytes across every file in it. */
export const SKILL_MAX_BYTES = 4_194_304;

/**
 * How deep under the skill's own directory the fetch walks. `references/` and
 * `scripts/` are the shapes skills use; four levels is well past both and stops
 * a repository that nests forever.
 */
export const SKILL_MAX_DEPTH = 4;

/**
 * The largest incoming file whose text travels in an update's answer.
 *
 * The answer is what somebody reads before accepting an update, so a file
 * bigger than this is reported as changed with no body rather than turned into
 * a response nobody can render. 128 KiB is many times the length of any
 * `SKILL.md` written so far.
 */
export const SKILL_DIFF_CONTENT_MAX = 131_072;

/** Statuses a JSON body reads as, and 300 is the first that is not one. */
const HTTP_OK = 200;
const HTTP_REDIRECT = 300;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

/**
 * The scope-relative directory holding one skill's real files.
 *
 * Composed from a branded name, so the path cannot leave the skills directory
 * — that is the whole reason `SkillName` refuses a separator.
 */
export const skillDirOf = (name: SkillName) => `${AGENT_SKILLS_DIR}/${name}`;

/** The scope-relative path of the link Claude would read. */
export const skillLinkOf = (name: SkillName) => `${CLAUDE_SKILLS_DIR}/${name}`;

/** How far up from the link's own directory the scope root is. Derived, so the two constants cannot drift apart. */
const UP_TO_SCOPE = CLAUDE_SKILLS_DIR.split("/")
  .map(() => "..")
  .join("/");

/**
 * What the link contains: `../../.agents/skills/<name>`.
 *
 * Relative, never a host path. The link is written on the host and read inside
 * a container, where the same two directories arrive through one bind at a
 * different absolute path — so an absolute target would resolve to nothing a
 * container can see, and the skill would be invisible to the only provider that
 * currently reads it.
 */
export const skillLinkTargetOf = (name: SkillName) =>
  `${UP_TO_SCOPE}/${AGENT_SKILLS_DIR}/${name}`;

/** Every skill one scope has installed, keyed by name. */
export const SkillsLock = Schema.Struct({
  skills: Schema.Record(Schema.String, SkillLockEntry),
  version: Schema.Number,
}).annotate({ identifier: "SkillsLock" });

export interface SkillsLock extends Schema.Schema.Type<typeof SkillsLock> {}

/** A scope with nothing installed. What a missing lock file means. */
export const EMPTY_SKILLS_LOCK: SkillsLock = {
  skills: {},
  version: SKILLS_LOCK_VERSION,
};

/** Total, so a caller decides what an unreadable lock means rather than dying on it. */
const decodeLock = Schema.decodeUnknownOption(SkillsLock);

/**
 * The lock a scope holds, or null when the file is not one.
 *
 * Null rather than an empty lock, because the two are worth telling apart at
 * the call site: nothing installed is the ordinary first case, and a file that
 * does not decode is something a person should be told about before this
 * process overwrites it.
 */
export const parseSkillsLock = (text: string): SkillsLock | null => {
  try {
    const parsed = decodeLock(JSON.parse(text) as unknown);
    return parsed._tag === "Some" ? parsed.value : null;
  } catch {
    return null;
  }
};

/** Two spaces and a trailing newline, which is what the repository's own lock file is. */
const LOCK_INDENT = 2;

/**
 * The lock as bytes, with its skills in name order.
 *
 * Sorted, so re-serializing an unchanged lock is byte-identical and the scope's
 * git history holds a commit only when something really changed. An
 * insertion-ordered object would produce a diff every time a skill was
 * reinstalled.
 */
export const serializeSkillsLock = (lock: SkillsLock) => {
  const skills: Record<string, SkillLockEntry> = {};
  for (const name of Object.keys(lock.skills).sort()) {
    const entry = lock.skills[name];
    if (entry !== undefined) {
      skills[name] = entry;
    }
  }
  return `${JSON.stringify({ skills, version: lock.version }, null, LOCK_INDENT)}\n`;
};

/** The lock with one skill recorded, replacing any row of that name. */
export const withSkill = (input: {
  readonly entry: SkillLockEntry;
  readonly lock: SkillsLock;
  readonly name: SkillName;
}): SkillsLock => ({
  skills: { ...input.lock.skills, [input.name]: input.entry },
  version: SKILLS_LOCK_VERSION,
});

/** The lock with one skill forgotten. Removing files without this leaves the lock lying. */
export const withoutSkill = (input: {
  readonly lock: SkillsLock;
  readonly name: SkillName;
}): SkillsLock => {
  const skills = { ...input.lock.skills };
  delete skills[input.name];
  return { skills, version: SKILLS_LOCK_VERSION };
};

/** One file of a skill, named relative to the skill's own directory. */
export interface SkillFile {
  readonly bytes: Uint8Array;
  /** Posix-separated, because it comes from a repository and is joined to a directory of ours. */
  readonly path: string;
}

/**
 * Orders files by path, so a hash and a comparison see one sequence.
 *
 * Compared by code unit rather than by `localeCompare`, which is what the rest
 * of this package sorts listings with: a locale-aware order depends on the
 * host's collation data, and the hash below would then change with the ICU
 * build rather than with the files.
 */
const byPath = (left: SkillFile, right: SkillFile) => {
  if (left.path === right.path) {
    return 0;
  }
  return left.path < right.path ? -1 : 1;
};

/** Separates the parts of one file in the hash. A path cannot contain it. */
const HASH_SEPARATOR = " ";

/**
 * The hash the lock records: sha256 over every file, in path order, each one
 * preceded by its path and its length.
 *
 * The length is in the digest as well as the bytes, so no two different file
 * sets can hash the same by shifting a byte across a boundary. Every file
 * counts, not only the `SKILL.md`, because a skill's references are part of
 * what was installed and an update that only touched one of them would
 * otherwise report nothing changed.
 */
export const skillHashOf = (files: readonly SkillFile[]) => {
  const hash = createHash("sha256");
  for (const file of [...files].sort(byPath)) {
    hash.update(
      `${file.path}${HASH_SEPARATOR}${file.bytes.length}${HASH_SEPARATOR}`
    );
    hash.update(file.bytes);
  }
  return hash.digest("hex");
};

/** One line of an update's review: which file, what happens to it, and its incoming text. */
export interface SkillFileChange {
  /** The incoming size, and zero for a file the source no longer has. */
  readonly bytes: number;
  /**
   * The incoming text, or null when there is none to show — a removed file,
   * bytes that are not UTF-8, or a file past {@link SKILL_DIFF_CONTENT_MAX}.
   * The installed side is not carried: a caller reads that through the file
   * routes, which is also where it can see what a run has since changed by hand.
   */
  readonly content: string | null;
  readonly path: string;
  readonly status: SkillFileStatus;
}

/** The incoming text of one file, or null when it is not text worth showing. */
const diffContentOf = (bytes: Uint8Array) => {
  if (bytes.length > SKILL_DIFF_CONTENT_MAX) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

/** Whether two files hold the same bytes. */
const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, at) => byte === right[at]);

/** What an incoming file does to the one installed under the same path. */
const statusOf = (input: {
  readonly incoming: SkillFile;
  readonly installed: SkillFile | undefined;
}): SkillFileStatus => {
  if (input.installed === undefined) {
    return "added";
  }
  return sameBytes(input.installed.bytes, input.incoming.bytes)
    ? "unchanged"
    : "changed";
};

/**
 * What an update would do to a skill's directory, file by file and in path
 * order.
 *
 * Pure, so the policy is asserted without a network and without a disk. It
 * reports removals as well as changes because applying an update prunes what
 * the source no longer has — a person accepting a diff should see that a file
 * they are relying on is about to go.
 */
export const compareSkillFiles = (input: {
  readonly incoming: readonly SkillFile[];
  readonly installed: readonly SkillFile[];
}): readonly SkillFileChange[] => {
  const installed = new Map(input.installed.map((file) => [file.path, file]));
  const changes: SkillFileChange[] = [];
  for (const file of [...input.incoming].sort(byPath)) {
    const status = statusOf({
      incoming: file,
      installed: installed.get(file.path),
    });
    changes.push({
      bytes: file.bytes.length,
      content: status === "unchanged" ? null : diffContentOf(file.bytes),
      path: file.path,
      status,
    });
  }
  const incoming = new Set(input.incoming.map((file) => file.path));
  for (const file of [...input.installed].sort(byPath)) {
    if (!incoming.has(file.path)) {
      changes.push({
        bytes: 0,
        content: null,
        path: file.path,
        status: "removed",
      });
    }
  }
  return changes;
};

/** Why a source could not be turned into a skill. Bounded, so a failure can be a metric tag. */
export const SKILL_SOURCE_REFUSALS = [
  "not_github",
  "not_a_skill_path",
  "not_found",
  "too_large",
  "too_many_files",
  "unauthorized",
  "unreachable",
] as const;

/** Which refusal. */
export const SkillSourceRefusal = Schema.Literals(SKILL_SOURCE_REFUSALS);
export type SkillSourceRefusal = typeof SkillSourceRefusal.Type;

/**
 * The source named could not be read as a skill.
 *
 * Typed and loud, unlike the other GitHub lookups in this package, which answer
 * null and log. Those run on a run's closing path where an unanswered question
 * must not fail the work; this one runs while a person waits, and "nothing
 * happened" with no reason is the worst possible answer to somebody who has
 * just typed a URL.
 */
export class SkillSourceUnreadable extends Schema.TaggedErrorClass<SkillSourceUnreadable>()(
  "Skills.SourceUnreadable",
  { detail: Schema.String, reason: SkillSourceRefusal }
) {}

/** The refusal, with the sentence a person reads. */
const refuse = (reason: SkillSourceRefusal, detail: string) =>
  Effect.fail(new SkillSourceUnreadable({ detail, reason }));

/** As much of a contents entry as a walk needs. */
const ContentEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  size: Schema.optionalKey(Schema.Number),
  type: Schema.String,
});

/** Total: a body that is not a listing is a source this cannot read. */
const decodeEntries = Schema.decodeUnknownOption(Schema.Array(ContentEntry));

/** What the contents API calls a directory, and the two kinds this walks past. */
const DIRECTORY_TYPE = "dir";
const FILE_TYPE = "file";

/** Which repository, which `SKILL.md`, and — for a test — which origin. */
export interface SkillFetchInput {
  /** Overridden by a test; production uses {@link GITHUB_CONTENTS_ORIGIN}. */
  readonly apiOrigin?: string;
  /** The path of the `SKILL.md` inside the repository. */
  readonly path: SkillSourcePath;
  /** The repository as a person writes it. Parsed here, and only GitHub answers. */
  readonly repoUrl: string;
}

/** What one fetch produced, before anything is written. */
export interface SkillFetchResult {
  readonly files: readonly SkillFile[];
  /** {@link skillHashOf} over those files, which is what the lock records. */
  readonly hash: string;
  /**
   * The directory holding the `SKILL.md`, which is the name the skill wants.
   * A plain string: whether it is a usable name is the caller's decode, so an
   * odd directory name fails with the brand's own message and a caller may
   * override it.
   */
  readonly name: string;
  /** The path asked for, carried back so a lock row is built from one value. */
  readonly skillPath: SkillSourcePath;
  /** `owner/repo`, exactly as the lock records it. */
  readonly source: string;
}

/** What a source resolves to once its shape has been checked. */
interface SkillSource {
  /** The directory holding the `SKILL.md`, relative to the repository root. */
  readonly directory: string;
  /** `owner/repo`, which is what the lock records and what the URL is built from. */
  readonly slug: string;
}

/**
 * The repository and directory a request names, or the refusal that says why it
 * is not a skill.
 *
 * Every check is about the shape of what was asked for rather than about what
 * GitHub holds, so all of them happen before a single request is made — a
 * malformed source costs this system no rate limit and reaches nobody's server
 * with our credential on it.
 */
const skillSourceOf = (
  input: SkillFetchInput
): Effect.Effect<SkillSource, SkillSourceUnreadable> => {
  const repo = parseRepoUrl(input.repoUrl);
  if (repo === null || repo.host !== GITHUB_HOST) {
    return refuse(
      "not_github",
      "the repository is not a github.com URL this can read"
    );
  }
  // The brand has refused `..`, a leading slash and a `.git` segment already.
  // Asked again here because this is where the path is joined to a URL: a
  // caller that got past the schema would otherwise have this process ask
  // GitHub for a path above the repository somebody named.
  if (relativePathRefusalOf(input.path) !== null) {
    return refuse(
      "not_a_skill_path",
      "the path is not one this will join to a repository"
    );
  }
  if (basename(input.path) !== SKILL_FILE) {
    return refuse("not_a_skill_path", `the path must end in ${SKILL_FILE}`);
  }
  const directory = dirname(input.path);
  return directory === "." || directory === "/"
    ? refuse(
        "not_a_skill_path",
        `a ${SKILL_FILE} at the root of a repository has no skill directory to install`
      )
    : Effect.succeed({ directory, slug: repo.slug });
};

/** The two questions a walk asks of one repository. */
interface ContentsReader {
  /** One file's bytes, raw rather than base64 in JSON. */
  readonly bytesOf: (
    path: string
  ) => Effect.Effect<Uint8Array, SkillSourceUnreadable>;
  /** One directory's entries. */
  readonly listing: (
    path: string
  ) => Effect.Effect<
    readonly (typeof ContentEntry.Type)[],
    SkillSourceUnreadable
  >;
}

/**
 * A reader bound to one repository and one credential.
 *
 * A record of two functions rather than two exported effects, because both of
 * them need the same four things and threading those through every call is how
 * one of them ends up asking a different origin than the other.
 */
const contentsReader = (input: {
  readonly http: HttpClient.HttpClient;
  readonly origin: string;
  readonly slug: string;
  readonly token: Redacted.Redacted | null;
}): ContentsReader => {
  /** One contents request, with the failure a status means already applied. */
  const get = Effect.fnUntraced(function* (path: string, accept: string) {
    const url = `${input.origin}/repos/${input.slug}/contents/${path}`;
    const response = yield* input.http
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeaders({
            accept,
            "user-agent": USER_AGENT,
            "x-github-api-version": API_VERSION,
          }),
          input.token === null
            ? (request) => request
            : HttpClientRequest.bearerToken(Redacted.value(input.token))
        )
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.andThen(
            Effect.logWarning("skills: github did not answer", cause),
            refuse("unreachable", "github did not answer")
          )
        )
      );
    if (response.status === HTTP_NOT_FOUND) {
      return yield* refuse(
        "not_found",
        `${input.slug} has no ${path}, or the configured credential cannot see it`
      );
    }
    if (
      response.status === HTTP_UNAUTHORIZED ||
      response.status === HTTP_FORBIDDEN
    ) {
      return yield* refuse(
        "unauthorized",
        "the configured github credential was refused, or its rate limit is spent"
      );
    }
    if (response.status < HTTP_OK || response.status >= HTTP_REDIRECT) {
      return yield* refuse("unreachable", `github answered ${response.status}`);
    }
    return response;
  });

  return {
    bytesOf: Effect.fnUntraced(function* (path: string) {
      const response = yield* get(path, RAW_ACCEPT);
      const buffer = yield* response.arrayBuffer.pipe(
        Effect.catchCause(() =>
          refuse("unreachable", "github stopped mid-file")
        )
      );
      return new Uint8Array(buffer);
    }),
    listing: Effect.fnUntraced(function* (path: string) {
      const response = yield* get(path, CONTENTS_ACCEPT);
      const body = yield* response.json.pipe(
        Effect.catchCause(() =>
          refuse(
            "unreachable",
            "github answered something that is not a listing"
          )
        )
      );
      const entries = decodeEntries(body);
      return entries._tag === "Some"
        ? entries.value
        : yield* refuse(
            "not_a_skill_path",
            "the path names a file rather than a directory of files"
          );
    }),
  };
};

/**
 * One directory of the source: its files, fetched, and the subdirectories left
 * to visit.
 *
 * `room` is how many more files the whole skill may hold, checked before any
 * bytes are asked for — so a path naming a directory of ten thousand files
 * costs one listing rather than ten thousand requests made with the operator's
 * credential.
 *
 * Anything that is neither a file nor a directory is skipped. A symlink or a
 * submodule names a path in somebody else's tree, and this system does not
 * recreate one in a scope of ours.
 */
const readSourceDirectory = Effect.fnUntraced(function* (input: {
  readonly path: string;
  readonly reader: ContentsReader;
  readonly room: number;
}) {
  const entries = yield* input.reader.listing(input.path);
  const directories: string[] = [];
  const files: SkillFile[] = [];
  for (const entry of entries) {
    if (entry.type === DIRECTORY_TYPE) {
      directories.push(entry.path);
      continue;
    }
    if (entry.type !== FILE_TYPE) {
      continue;
    }
    if ((entry.size ?? 0) > SKILL_MAX_FILE_BYTES) {
      return yield* refuse(
        "too_large",
        `${entry.path} is larger than ${SKILL_MAX_FILE_BYTES} bytes`
      );
    }
    if (files.length >= input.room) {
      return yield* refuse(
        "too_many_files",
        `a skill may hold at most ${SKILL_MAX_FILES} files`
      );
    }
    const bytes = yield* input.reader.bytesOf(entry.path);
    files.push({ bytes, path: entry.path });
  }
  return { directories, files };
});

/**
 * Every file under the skill's directory, breadth first.
 *
 * A queue rather than a recursive call: the walk is a loop with three caps on
 * it, and each of them is one condition here instead of an argument threaded
 * through a self reference. Appending to the array being iterated is what makes
 * it breadth first, which is the order that reaches the `SKILL.md` before
 * anything nested under it.
 */
const collectSkillFiles = Effect.fnUntraced(function* (input: {
  readonly directory: string;
  readonly reader: ContentsReader;
}) {
  const files: SkillFile[] = [];
  let total = 0;
  const pending = [{ depth: 0, path: input.directory }];

  for (const current of pending) {
    const found = yield* readSourceDirectory({
      path: current.path,
      reader: input.reader,
      room: SKILL_MAX_FILES - files.length,
    });
    for (const file of found.files) {
      total += file.bytes.length;
      // Named relative to the skill's own directory, which is where they are
      // about to be written.
      files.push({
        bytes: file.bytes,
        path: file.path.slice(input.directory.length + 1),
      });
    }
    if (total > SKILL_MAX_BYTES) {
      return yield* refuse(
        "too_large",
        `the skill is larger than ${SKILL_MAX_BYTES} bytes`
      );
    }
    if (found.directories.length > 0 && current.depth + 1 >= SKILL_MAX_DEPTH) {
      return yield* refuse(
        "too_many_files",
        `the skill nests deeper than ${SKILL_MAX_DEPTH} directories`
      );
    }
    for (const path of found.directories) {
      pending.push({ depth: current.depth + 1, path });
    }
  }
  return files as readonly SkillFile[];
});

/**
 * The files of one skill, fetched from the repository that holds them.
 *
 * Reuses the credential this system already has rather than adding a second way
 * to authenticate: {@link readGithubToken} is the operator's `ATM_GITHUB_TOKEN`,
 * the same value the host's git clones with and a run's `gh` is logged in with.
 * A public repository needs none of it, and an install with no token configured
 * reads exactly what an anonymous request can read.
 *
 * Provides its own HTTP client, matching `./committer` and `./pull-request`:
 * the caller is a request handler, and a requirement added there would put an
 * HTTP client in the environment of every route in the gateway.
 *
 * The skill is the *directory* holding the `SKILL.md`, walked to
 * {@link SKILL_MAX_DEPTH} — a document that refers to a `references/` file and
 * arrives without it is a skill that half works. A `SKILL.md` at the root of a
 * repository is refused for the same reason: there the directory is the whole
 * repository, and copying a repository into a scope is not installing a skill.
 */
export const fetchSkillFiles = Effect.fn("Skills.fetch")(
  function* (input: SkillFetchInput) {
    const source = yield* skillSourceOf(input);
    const reader = contentsReader({
      http: yield* HttpClient.HttpClient,
      origin: input.apiOrigin ?? GITHUB_CONTENTS_ORIGIN,
      slug: source.slug,
      token: yield* readGithubToken,
    });
    const files = yield* collectSkillFiles({
      directory: source.directory,
      reader,
    });
    if (!files.some((file) => file.path === SKILL_FILE)) {
      return yield* refuse(
        "not_a_skill_path",
        `${source.directory} holds no ${SKILL_FILE}`
      );
    }
    return {
      files,
      hash: skillHashOf(files),
      name: basename(source.directory),
      skillPath: input.path,
      source: source.slug,
    } satisfies SkillFetchResult;
  },
  // Outside the walk, so the cap covers every request the skill needed rather
  // than each of them separately.
  Effect.timeoutOrElse({
    duration: FETCH_TIMEOUT,
    orElse: () => refuse("unreachable", "github did not answer in time"),
  }),
  Effect.provide(FetchHttpClient.layer)
);

/** Where one skill's files sit inside a scope, once it is installed. */
export interface SkillPaths {
  /** Scope-relative, holding the real files. */
  readonly directory: string;
  /** Scope-relative, the symbolic link beside them. */
  readonly link: string;
  /** What that link contains, which is relative and stays relative. */
  readonly linkTarget: string;
}

/** The three paths one name resolves to. Together, because nothing wants one without the others. */
export const skillPathsOf = (name: SkillName): SkillPaths => ({
  directory: skillDirOf(name),
  link: skillLinkOf(name),
  linkTarget: skillLinkTargetOf(name),
});

/** The scope-relative path of one file inside one skill. */
export const skillFilePathOf = (input: {
  readonly name: SkillName;
  readonly path: string;
}) => join(skillDirOf(input.name), input.path);
