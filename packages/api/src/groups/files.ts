/**
 * The agent filesystem, as seven operations over one addressable directory.
 *
 * A run is handed a nested tree of directories and reads its instructions by
 * walking up it. Those directories are ordinary folders on the host, and until
 * this group existed the only ways into them were a promotion, a proposal a
 * person confirmed, and a run's own writes — which is to say, no way to fix a
 * typo in the house rules and no way to install a skill. This is that way.
 *
 * **One route per operation, not one per scope.** The scope is a path segment
 * that decodes into a tagged union, so `workspace`, `manager`, `project:<id>`
 * and `task:<id>` all reach the same handler and the same containment. The
 * alternative — a family of routes per scope — is four copies of a security
 * check, which is three too many.
 *
 * **Every operation is admin-scoped, reads included, and that is the deliberate
 * part.** An agent credential's ceiling is `task-write` and can never be minted
 * higher, so admin is the one way to say "a person, and only a person" in a form
 * the token machinery enforces rather than a form a handler remembers. A run
 * that could write here would be a run editing what every later run is given,
 * which is exactly what its read-only workspace mount and the proposal path
 * exist to prevent — going around them through an HTTP route would leave the
 * mount flag as decoration.
 *
 * Reads are admin for a quieter reason. A run's mount set is the security
 * boundary: it sees its own task scope, its project's, and the workspace
 * read-only, and it sees no other task's folder at all. A listing route at
 * `read` scope would hand any run every other task's output, which nothing in
 * the container's design allows.
 *
 * **`.git` is unreachable, at the type level.** Every path here is a
 * `ScopePath`, which refuses a `.git` segment anywhere along with `..`, a
 * leading slash and a control character — so the refusal is a decode failure at
 * the edge of the system rather than a check inside six handlers. The shared
 * scopes are git repositories whose history is the audit trail of what each run
 * and each person changed; a route that could write into the object store would
 * erase precisely the record it is being audited by.
 *
 * **There is no terminal here, and there will not be one.** A shell in the
 * dashboard runs as the loop process, which holds the GitHub token, the database
 * credentials and the agent-home logins. These seven operations are what a
 * person needs to keep a tree in order, and they are all a person gets.
 */

import { FileScopeAddress, ScopePath } from "@workspace/domain";
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import { Forbidden, InvalidInput, NotFound, PayloadTooLarge } from "../errors";
import {
  FileContent,
  FileDirectoryCreate,
  FileEntry,
  FileLinkCreate,
  FileMove,
  FileWrite,
} from "../schemas/file";
import { AdminAccess } from "../security";

/** The scope segment every operation here nests below. */
const scopeParams = { scope: FileScopeAddress };

/**
 * What is in one directory, directories first and then by name — the order a
 * browser renders and therefore the order that costs the client no sort.
 *
 * The path is optional, and absent means the scope's own root. That is the only
 * way to name the root at all: the empty string is not a `ScopePath`, which is
 * what makes "no route can delete, move or overwrite a whole scope" a property
 * of the type rather than of a check.
 *
 * A path that is not a directory is refused rather than answered with an empty
 * array, which would tell a browser that a folder is there and empty.
 *
 * A `.git` directory is not in the answer. It is the scope's audit trail rather
 * than its contents, no path here can address it, and listing it would offer a
 * person thousands of object files to click on.
 */
const list = HttpApiEndpoint.get("list", "/files/:scope", {
  error: [Forbidden, InvalidInput, NotFound],
  params: scopeParams,
  query: { path: Schema.optionalKey(ScopePath) },
  success: Schema.Array(FileEntry),
})
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "List a directory in a scope");

/**
 * One file's bytes, capped and encoding-tagged.
 *
 * Capped rather than streamed, because this is the editor's read: it buffers to
 * decide whether the bytes are text, and a file too large for that is a file
 * this route should refuse rather than one it should half-read. An artifact
 * bigger than the cap is still downloadable through the artifacts group, which
 * streams.
 *
 * A symlink is followed, and only if it lands inside the same scope. Reading
 * through a link a run planted is how the gateway — which runs on the host,
 * with the host's reach — would be made to read anything the loop user can
 * read.
 */
const read = HttpApiEndpoint.get("read", "/files/:scope/content", {
  error: [Forbidden, InvalidInput, NotFound, PayloadTooLarge],
  params: scopeParams,
  query: { path: ScopePath },
  success: FileContent,
})
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "Read a file's bytes");

/**
 * Writes one file, creating the directories above it, and commits the change to
 * the scope's history.
 *
 * `POST` rather than `PUT` because the answer carries the entry that was
 * written — its real size and modified time, read back off the disk — which is
 * what a browser needs to refresh a listing without a second call.
 *
 * A path whose last segment is already a symlink is refused rather than
 * followed. That is the one containment a check of the parent directory misses:
 * a link planted in the scope whose target does not exist yet passes every test
 * about where its parent is, and the write then creates the target wherever the
 * link points.
 */
const write = HttpApiEndpoint.post("write", "/files/:scope/content", {
  error: [Forbidden, InvalidInput, NotFound, PayloadTooLarge],
  params: scopeParams,
  payload: FileWrite,
  success: FileEntry,
})
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "Write a file into a scope");

/**
 * Creates a directory and its parents. Separate from a write because a skill,
 * and any other layout with a shape, exists as directories before it has a file
 * in it — and because `mkdir -p` on a path that is already a directory is the
 * ordinary no-op a browser's "new folder" wants.
 */
const createDirectory = HttpApiEndpoint.post(
  "createDirectory",
  "/files/:scope/directory",
  {
    error: [Forbidden, InvalidInput, NotFound],
    params: scopeParams,
    payload: FileDirectoryCreate,
    success: FileEntry,
  }
)
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "Create a directory in a scope");

/**
 * Points one name at another file in the same scope, with a relative symbolic
 * link, and commits it.
 *
 * Its own route rather than a flavour of `write`, because what is being created
 * is not bytes: a caller gives two scope-relative paths and the server computes
 * the link text from the first's directory to the second. There is no way to
 * ask for an absolute link, which is the point — a scope is a bind mount, so a
 * host path in a link resolves for the person who typed it and dangles inside
 * every container that reads the tree.
 *
 * What it is for: `AGENTS.md` holds a rule and `CLAUDE.md` links to it, since
 * Claude does not read the first name and Codex does not read the second. One
 * file, two names, and nothing to keep in step by hand.
 *
 * The target has to exist and must not itself be a link. Both refusals are
 * about what a person can see: a dangling link is a rule that silently reaches
 * nothing, and a chain of links is a tree whose listing no longer says what a
 * name resolves to. A target that does not exist yet would also be a way past
 * containment, since the check would have nothing on disk to resolve.
 */
const createLink = HttpApiEndpoint.post("createLink", "/files/:scope/link", {
  error: [Forbidden, InvalidInput, NotFound],
  params: scopeParams,
  payload: FileLinkCreate,
  success: FileEntry,
})
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "Link one name to another file in a scope");

/**
 * Renames a file or a directory inside one scope, and commits it.
 *
 * Both ends are contained separately, and the destination must not exist — a
 * move that silently replaced a file would be the one operation here with no
 * "are you sure", and the bytes it replaced would be findable only by somebody
 * who thought to look in `git log`.
 */
const move = HttpApiEndpoint.post("move", "/files/:scope/move", {
  error: [Forbidden, InvalidInput, NotFound],
  params: scopeParams,
  payload: FileMove,
  success: FileEntry,
})
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "Move a file or directory within a scope");

/**
 * Removes a file, a link, or a directory and everything under it, and commits
 * the removal.
 *
 * Recursive with no flag to ask for it, which is safe for a reason specific to
 * these directories rather than by assumption: the two shared scopes are git
 * repositories and this operation commits, so what was deleted is still in the
 * folder's own history and `git show` brings it back. The scope root itself is
 * not addressable, so the worst a call can do is a subtree of one scope.
 *
 * A symlink is unlinked, never followed. Deleting a bad link is one of the
 * repairs a person comes to this route for, and following it would delete
 * whatever it happened to point at.
 */
const remove = HttpApiEndpoint.delete("delete", "/files/:scope", {
  error: [Forbidden, InvalidInput, NotFound],
  params: scopeParams,
  query: { path: ScopePath },
})
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "Delete a path in a scope");

/** The tree a run reads its rules from, as something a person can open and edit. */
export class FilesGroup extends HttpApiGroup.make("files")
  .add(list, read, write, createDirectory, createLink, move, remove)
  .annotate(
    OpenApi.Description,
    "The agent filesystem: the directories a run walks for its instructions, browsable and editable by a person."
  ) {}
