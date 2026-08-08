/**
 * The agent filesystem on the wire: what a directory holds, and what one file
 * says.
 *
 * These are not artifact rows. An artifact is a row in Postgres describing a
 * file a run kept, and it is a cache of one directory scanned after a run;
 * this is the directory itself, read at the moment somebody asks. The two
 * overlap on disk and answer different questions — "what did that run produce"
 * against "what is in this folder right now, including the symlink somebody
 * planted in it".
 *
 * **A listing distinguishes three kinds and says where a link points.** The
 * skills layout is one real directory under `.agents/skills/<name>` and a
 * relative symlink at `.claude/skills/<name>` pointing at it, so a browser that
 * showed the link as an ordinary directory would show one skill twice and give
 * no way to tell which copy an edit lands in. It would also hide the interesting
 * case: a link out of the scope, which every route here refuses to follow and a
 * person should be able to see.
 *
 * **Content travels with the encoding it survived.** A file is bytes, and the
 * bytes a person edits in a browser are text — so a read says which of the two
 * it is handing back, and a file that is not valid UTF-8 comes back base64
 * rather than as a string with replacement characters in it. That is the whole
 * failure this field exists to prevent: an editor that reads a PNG as text and
 * saves it back has destroyed the file, silently, and no error was ever raised.
 */

import { ScopePath, Timestamp } from "@workspace/domain";
import { Schema } from "effect";

/**
 * The largest file these routes read or write, in bytes: four mebibytes.
 *
 * A cap rather than none, because a read buffers the whole file to answer with
 * it and these routes exist for rules documents, skills and small data — the
 * hundred-megabyte scrape a run produced is an artifact, and
 * `/tasks/:taskId/artifacts/:artifactId/content` streams it. Named here so the
 * server's refusal and a client's own check are the same number.
 */
export const MAX_FILE_BYTES = 4_194_304;

/**
 * What a directory entry is. Three kinds and not the filesystem's full list: a
 * socket or a device node in an artifacts folder is something nobody put there
 * on purpose, and it lists as a file rather than as a fourth case every consumer
 * would have to render.
 */
export const FILE_ENTRY_KINDS = ["file", "directory", "symlink"] as const;

/** Whether an entry is a file, a directory, or a link to one of those. */
export const FileEntryKind = Schema.Literals(FILE_ENTRY_KINDS);
export type FileEntryKind = typeof FileEntryKind.Type;

/**
 * One entry of one directory.
 *
 * `path` and `name` are plain strings rather than the branded {@link ScopePath}
 * a request carries, and that asymmetry is deliberate. A directory can hold a
 * name this system would never accept — a backslash, a control character — and
 * a listing that refused to encode such a row would answer a whole folder with
 * a 500 because one file in it is oddly named. So a listing describes what is
 * there, and a file whose name no request can spell is visible and not
 * openable, which is the honest pair.
 */
export const FileEntry = Schema.Struct({
  /** The size of a regular file. Null for a directory and for a link, which is not followed to size it. */
  bytes: Schema.NullOr(Schema.Natural),
  /** Lowercase, no dot, and null where there is none — so a dotfile is a name rather than a type. */
  ext: Schema.NullOr(Schema.String),
  kind: FileEntryKind,
  /** Null where the entry could not be stat'd at all, which in practice means a link with no target. */
  modifiedAt: Schema.NullOr(Timestamp),
  /** The last segment, for a browser that has already rendered the parent. */
  name: Schema.String,
  /** Relative to the scope's own root, which is the only path any route here accepts. */
  path: Schema.String,
  /** The link text exactly as it is stored, and null for anything that is not a link. */
  target: Schema.NullOr(Schema.String),
  /**
   * True when following {@link target} leaves the scope. Advisory and cheap: it
   * resolves the link text once, where every route resolves the whole path
   * through the disk before it touches anything. A browser should mark such an
   * entry rather than offer to open it.
   */
  targetOutsideScope: Schema.Boolean,
}).annotate({ identifier: "FileEntry" });

export interface FileEntry extends Schema.Schema.Type<typeof FileEntry> {}

/**
 * How a file's bytes are carried in JSON. `utf8` for anything that decodes as
 * text, `base64` for everything else — a client that only handles the first can
 * refuse the second, which is what an editor should do with a binary.
 */
export const FILE_ENCODINGS = ["utf8", "base64"] as const;

/** Which of the two encodings a body is in. */
export const FileEncoding = Schema.Literals(FILE_ENCODINGS);
export type FileEncoding = typeof FileEncoding.Type;

/**
 * One file's bytes, with the size they really are.
 *
 * `bytes` is the length on disk rather than the length of {@link content},
 * which differ whenever the encoding is base64 — so "is this the file I wrote"
 * is answerable without decoding, and a client can compare it with the listing
 * it came from.
 */
export const FileContent = Schema.Struct({
  bytes: Schema.Natural,
  content: Schema.String,
  encoding: FileEncoding,
  path: Schema.String,
}).annotate({ identifier: "FileContent" });

export interface FileContent extends Schema.Schema.Type<typeof FileContent> {}

/**
 * A file to write, and where in the scope to put it.
 *
 * The encoding is required rather than defaulted to text. A default would make
 * the one dangerous case — base64 bytes written as if they were characters —
 * the case a caller reaches by forgetting a field, and the corruption would be
 * silent on both ends.
 *
 * Writing a path that already holds a file replaces it. What the old bytes were
 * is in the scope's own git history, which is why replacing is allowed to be
 * this ordinary.
 */
export const FileWrite = Schema.Struct({
  content: Schema.String,
  encoding: FileEncoding,
  path: ScopePath,
}).annotate({ identifier: "FileWrite" });

export interface FileWrite extends Schema.Schema.Type<typeof FileWrite> {}

/**
 * A directory to create, parents included. The skills layout is two directories
 * deep before the first file exists, so refusing to create a parent would make
 * the ordinary case three calls.
 */
export const FileDirectoryCreate = Schema.Struct({
  path: ScopePath,
}).annotate({ identifier: "FileDirectoryCreate" });

export interface FileDirectoryCreate
  extends Schema.Schema.Type<typeof FileDirectoryCreate> {}

/**
 * A symbolic link to create, and the file or directory in the same scope it
 * names.
 *
 * Both ends are scope-relative, and what lands on disk is the relative path
 * from the link's own directory to {@link target} — never either string as
 * given, and never a host path. A scope is a bind mount, so a link holding
 * `/var/lib/atm/artifacts/global/AGENTS.md` resolves for the person who made it
 * and dangles for every run that reads the tree, which is the failure this
 * shape exists to make unrepresentable: a caller cannot express an absolute
 * link at all.
 *
 * The case it is for is one rule under two names. `AGENTS.md` holds the text
 * and `CLAUDE.md` links to it, because Claude does not read the first and Codex
 * does not read the second — one file to edit, and no pair to keep in step by
 * hand.
 */
export const FileLinkCreate = Schema.Struct({
  /** Where the link goes. Nothing may be there already, link or not. */
  path: ScopePath,
  /**
   * What it points at: a path in the same scope that exists and is not itself a
   * link. One hop, so what a name resolves to is readable from one listing.
   */
  target: ScopePath,
}).annotate({ identifier: "FileLinkCreate" });

export interface FileLinkCreate
  extends Schema.Schema.Type<typeof FileLinkCreate> {}

/**
 * A rename, within one scope.
 *
 * Both ends are scope-relative because a move between scopes is a different
 * decision with a different audit trail — that is what promotion is for, and it
 * copies bytes and records who chose to. A move here is the same file under a
 * different name in the same folder, which is what organising a directory is.
 */
export const FileMove = Schema.Struct({
  from: ScopePath,
  to: ScopePath,
}).annotate({ identifier: "FileMove" });

export interface FileMove extends Schema.Schema.Type<typeof FileMove> {}
