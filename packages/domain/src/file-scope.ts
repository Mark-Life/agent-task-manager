/**
 * How a person names one directory of the agent filesystem, and one file inside
 * it.
 *
 * A run is handed a nested tree — house rules, then the manager's own rules,
 * then a project's, then a task's — and every level of it is a directory on the
 * host that somebody has to be able to open, edit and organise from outside a
 * container. That is what these two names are for: {@link FileScope} says which
 * level, {@link ScopePath} says which file inside it, and nothing anywhere else
 * gets to spell either.
 *
 * **A tagged union, not a scope plus two nullable ids.** A project address
 * without a project and a workspace address carrying one are both
 * unrepresentable here, so the resolver that turns an address into a host
 * directory is total over four cases — and a case somebody forgets to handle is
 * a compile error rather than a route answering with the wrong directory. It is
 * the same reasoning `@workspace/sandbox`'s `ArtifactLocation` is built on, and
 * this is deliberately not that type: the artifact index knows three scopes
 * whose names a database column holds, and the manager's directory is not one
 * of them — it holds no artifacts, it has no row, and it is a plain
 * subdirectory of the workspace scope rather than a folder of its own. It also
 * calls the top scope `global`, where a proposal, a mount and a run's own
 * instruction tree all call it `workspace`. So the two vocabularies meet in one
 * function in that package rather than being forced into one name here.
 *
 * **The wire form is one string.** `workspace`, `manager`, `project:<id>`,
 * `task:<id>` — one path segment, so every operation on a directory is one
 * route rather than one route per scope, and a client that can name a scope in
 * a URL can name it in a link. {@link FileScopeAddress} is the schema that
 * parses it, which means an unreadable address is a decode failure at the edge
 * and never a handler's problem.
 */

import { Schema, SchemaGetter } from "effect";
import { ProjectId, TaskId } from "./ids";
import { relativePathFilter } from "./relative-path";

/**
 * The four levels of the tree, shallowest first. The order is the nesting
 * order, so a reader of the list reads the tree.
 */
export const FILE_SCOPES = ["workspace", "manager", "project", "task"] as const;

/** Which level of the tree, without the id that two of them need. */
export const FileScopeKind = Schema.Literals(FILE_SCOPES);
export type FileScopeKind = typeof FileScopeKind.Type;

/**
 * One directory of the tree, addressed.
 *
 * `workspace` is the house rules every run of both roles walks past.
 * `manager` is the chat role's own rules, which live inside the workspace
 * directory rather than in a bind of their own — a worker can see it and never
 * walks into it. `project` and `task` each need the row they belong to, and
 * carry it.
 *
 * Built with a tag rather than a plain literal so the union gets `match`: the
 * resolver that turns one of these into a host directory is then exhaustive by
 * construction, which is the entire reason this is a union and not a string.
 */
export const FileScope = Schema.Union([
  Schema.Struct({ scope: Schema.tag("workspace") }),
  Schema.Struct({ scope: Schema.tag("manager") }),
  Schema.Struct({ projectId: ProjectId, scope: Schema.tag("project") }),
  Schema.Struct({ scope: Schema.tag("task"), taskId: TaskId }),
]).pipe(Schema.toTaggedUnion("scope"));

export type FileScope = typeof FileScope.Type;

/**
 * What separates a scope from the id it needs. A colon rather than a slash,
 * because the whole address is one path segment: a slash would split it across
 * two and turn every route into two routes that have to agree.
 */
export const FILE_SCOPE_SEPARATOR = ":";

/** The address a client puts in a URL. The inverse of the parse below. */
export const fileScopeAddressOf = (scope: FileScope): string =>
  FileScope.match(scope, {
    manager: () => "manager",
    project: (self) =>
      `project${FILE_SCOPE_SEPARATOR}${self.projectId satisfies ProjectId}`,
    task: (self) =>
      `task${FILE_SCOPE_SEPARATOR}${self.taskId satisfies TaskId}`,
    workspace: () => "workspace",
  });

/** The encoded form of one address: what the union decodes from. */
type EncodedFileScope = typeof FileScope.Encoded;

/**
 * The address as the union's encoded shape, or null when it is not an address
 * at all.
 *
 * Shape only. Whether the id is a uuid is the union's own question, asked a
 * moment later when it decodes — so a mistyped id fails with the branded
 * schema's message rather than with a second, weaker one written here.
 */
const parseAddress = (address: string): EncodedFileScope | null => {
  if (address === "workspace" || address === "manager") {
    return { scope: address };
  }
  const at = address.indexOf(FILE_SCOPE_SEPARATOR);
  if (at <= 0) {
    return null;
  }
  const id = address.slice(at + 1);
  if (id.length === 0) {
    return null;
  }
  const kind = address.slice(0, at);
  if (kind === "project") {
    return { projectId: id, scope: kind };
  }
  return kind === "task" ? { scope: kind, taskId: id } : null;
};

/**
 * One URL path segment naming a scope, decoded into {@link FileScope}.
 *
 * The check runs before the transform, so a segment that is not an address at
 * all is refused with a sentence naming the four forms rather than reaching a
 * transform that would have to guess. What survives the check is parsed by a
 * function that cannot fail, which is what keeps the decoding path total.
 *
 * The generated document describes this as a plain string. That is honest: a
 * client writes `workspace` or `project:<id>` into a URL, and the union it
 * becomes is the server's business.
 */
export const FileScopeAddress = Schema.String.annotate({
  description:
    "The directory being browsed: workspace, manager, project:<projectId> or task:<taskId>.",
  identifier: "FileScopeAddress",
}).pipe(
  Schema.check(
    Schema.makeFilter((address: string) =>
      parseAddress(address) === null
        ? "not a scope address: expected workspace, manager, project:<id> or task:<id>"
        : undefined
    )
  ),
  Schema.decodeTo(FileScope, {
    decode: SchemaGetter.transform(
      (address: string) => parseAddress(address) as EncodedFileScope
    ),
    encode: SchemaGetter.transform((encoded: EncodedFileScope) =>
      fileScopeAddressOf(encoded as FileScope)
    ),
  })
);

/**
 * A file or directory inside a scope, named relative to that scope's root.
 *
 * Branded off the same rule a proposal's path and a project's environment file
 * are branded off, so the three features that join a caller's path to a
 * directory of ours refuse the same things for the same reasons: `..`, a
 * leading slash, a control character, and a `.git` segment anywhere. The last
 * one matters most here — every shared scope is a git repository whose history
 * is the audit trail of what a person and a run each changed, and a route that
 * could write into the object store would erase exactly that.
 *
 * The empty string is refused too, which is what makes "no route can delete,
 * move or overwrite a scope's own root" true of the type rather than of a check
 * each handler remembers. Listing the root is expressed by omitting the path,
 * not by naming it.
 */
export const ScopePath = Schema.String.annotate({
  description:
    "A path relative to the scope's own root. No leading slash, no `..`, and no `.git` segment.",
  identifier: "ScopePath",
}).pipe(
  Schema.check(relativePathFilter("scope-relative path")),
  Schema.brand("ScopePath")
);

export type ScopePath = typeof ScopePath.Type;
