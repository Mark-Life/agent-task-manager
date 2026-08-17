/**
 * The checker session: which tsconfigs to open, which files each project
 * contributes, and how a declaration turns into a {@link SourceLoc}.
 *
 * The async API is the one that runs under Bun. Its sync twin reaches into
 * Node stream internals that Bun's `child_process` does not expose, so
 * `new API()` throws before the first project loads. The cost is that every
 * checker call, and `Type.getSymbol()` / `getTypes()` / `getTarget()` with
 * them, returns a Promise: a forgotten `await` does not throw, it silently
 * hands every `.name` test a truthy Promise.
 */

import { existsSync } from "node:fs";
import type { Node } from "typescript/unstable/ast";
import {
  isIdentifier,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
} from "typescript/unstable/ast/is";
import { API } from "typescript/unstable/async";
import type { EdgeKind, GraphBuilder, SourceLoc, Unresolved } from "../graph";
import type { TypeRef } from "./effect";

/** `SignatureKind.Call` is how a layer factory is told from a layer. */
export { SignatureKind } from "typescript/unstable/async";

/** The `Snapshot` the API hands back. Derived so no unexported name is named. */
type TsSnapshot = Awaited<ReturnType<API["updateSnapshot"]>>;

/** One opened tsconfig, with its program, checker and emitter. */
export type TsProject = ReturnType<TsSnapshot["getProjects"]>[number];

export type TsChecker = TsProject["checker"];

/** The API's `Symbol`, which shadows the global one if imported by name. */
export type TsSymbol = Awaited<ReturnType<TsChecker["getAliasedSymbol"]>>;

export type TsType = Awaited<ReturnType<TsChecker["getDeclaredTypeOfSymbol"]>>;

/** A `NodeHandle`: `{ index, kind, path }`, where `path` is lowercased. */
export type TsDeclaration = TsSymbol["declarations"][number];

/** Files that carry no node worth drawing, whatever the checker says of them. */
const SKIPPED_FILE = /\.d\.ts$|\.test\.tsx?$/;

/** Anything under here belongs to a dependency, not to this repo. */
const VENDOR = "node_modules";

const CONFIG_SUFFIX = "/tsconfig.json";

/**
 * The tsconfigs to open, one per workspace, read off the root `package.json`'s
 * workspace globs.
 *
 * Never the root `tsconfig.json`. It loads, and it does contain every workspace
 * file, but it resolves modules as `NodeNext` where every workspace resolves as
 * `Bundler` — so every cross-package import goes unresolved and every type
 * comes back `any`.
 */
export const discoverConfigs = async (root: string) => {
  const patterns = await workspacePatterns(root);
  const configs: string[] = [];
  for (const pattern of patterns) {
    const scan = new Bun.Glob(`${pattern}${CONFIG_SUFFIX}`).scan({
      cwd: root,
      onlyFiles: true,
    });
    // biome-ignore lint/performance/noAwaitInLoops: a directory scan is a stream, not a list to gather first
    for await (const match of scan) {
      configs.push(`${root}/${match}`);
    }
  }
  return configs.filter((file) => existsSync(file)).sort();
};

/** The `workspaces.packages` globs, or the monorepo's own layout as a fallback. */
export const workspacePatterns = async (root: string) => {
  const manifest = await readManifest(`${root}/package.json`);
  const declared = manifest?.workspaces?.packages;
  return declared && declared.length > 0
    ? declared
    : ["apps/*", "packages/*", "scripts"];
};

/** A `package.json`, in the shape the atlas reads it. Absent file reads as undefined. */
export const readManifest = async (file: string) => {
  if (!existsSync(file)) {
    return;
  }
  return (await Bun.file(file).json()) as {
    readonly name?: string;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
    readonly workspaces?: { readonly packages?: readonly string[] };
  };
};

/** Opens the tsgo API over `configs`. The caller must `close()` in a `finally`. */
export const openSession = async ({
  root,
  configs,
}: {
  readonly root: string;
  readonly configs: readonly string[];
}) => {
  const started = Date.now();
  const api = new API({ cwd: root });
  const snapshot = await api.updateSnapshot({ openProjects: [...configs] });
  return {
    close: () => api.close(),
    // Opening every project is a measurable slice of the run, so the CLI
    // reports it apart from the walk and a slow run says which half was slow.
    ms: Date.now() - started,
    projects: snapshot.getProjects(),
  };
};

/**
 * The files of one project this walk owns: everything under its own directory,
 * no vendored code, no declarations, no tests.
 *
 * The bound is the project directory rather than its `src`, because `scripts`
 * keeps its thirteen error classes at the top level and a `src`-only rule loses
 * every one of them. Projects see each other's sources through imports — the
 * gateway's program holds 64 `packages/db` files — so the caller dedupes across
 * projects too, or every shared file is classified once per program.
 */
export const projectSourceFiles = async (project: TsProject) => {
  const dir = project.configFileName.slice(0, -CONFIG_SUFFIX.length);
  const names = await project.program.getSourceFileNames();
  return names.filter(
    (file) =>
      file.startsWith(`${dir}/`) &&
      !file.includes(VENDOR) &&
      !SKIPPED_FILE.test(file)
  );
};

/** `/abs/repo/packages/db/store.ts` as `packages/db/store.ts`. */
export const relativeFile = (root: string, file: string) =>
  file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;

/**
 * Where a symbol was declared, real-cased and 1-based.
 *
 * The handle's own `path` is a lowercased `Path` — good as a dedupe key, wrong
 * as a link on a case-sensitive disk — so the node is resolved and its source
 * file asked for the name it really has. The checker counts lines and
 * characters from zero; editors count from one.
 */
export const loc = async ({
  declaration,
  project,
  root,
}: {
  readonly declaration: TsDeclaration | undefined;
  readonly project: TsProject;
  readonly root: string;
}): Promise<SourceLoc | undefined> => {
  const node = await declaration?.resolve(project);
  return node && nodeLoc({ node, root });
};

/** The AST node one declaration handle points at, inside this project. */
export const declarationNode = ({
  declaration,
  project,
}: {
  readonly declaration: TsDeclaration | undefined;
  readonly project: TsProject;
}) => declaration?.resolve(project);

/** {@link SourceLoc} for a node already resolved. */
export const nodeLoc = ({
  node,
  root,
}: {
  readonly node: Node;
  readonly root: string;
}): SourceLoc => {
  const file = node.getSourceFile();
  const { line, character } = file.getLineAndCharacterOfPosition(
    node.getStart()
  );
  return {
    column: character + 1,
    file: relativeFile(root, file.fileName),
    line: line + 1,
  };
};

/**
 * Where a member of a service's shape is really written.
 *
 * A service returns its shape as an object literal — `return { create, byId,
 * delete: remove }` — so the member's declaration is that one line, and every
 * method of a repository reports the same location three lines apart from its
 * siblings. Both spellings name a value declared elsewhere in the file, and it
 * is that declaration a reader wants to open, so the entry is followed to it
 * and only an unfollowable one keeps the literal's own position.
 */
export const memberLoc = async ({
  checker,
  declaration,
  project,
  root,
}: {
  readonly checker: TsChecker;
  readonly declaration: TsDeclaration | undefined;
  readonly project: TsProject;
  readonly root: string;
}): Promise<SourceLoc | undefined> => {
  const node = await declaration?.resolve(project);
  if (!node) {
    return;
  }
  const value = await valueDeclaration({ checker, node, project });
  return nodeLoc({ node: value ?? node, root });
};

/** The declaration an object-literal entry points at, when it points at one. */
const valueDeclaration = async ({
  checker,
  node,
  project,
}: {
  readonly checker: TsChecker;
  readonly node: Node;
  readonly project: TsProject;
}) => {
  const symbol = await entrySymbol({ checker, node });
  const [declaration] = symbol?.declarations ?? [];
  return declaration ? await declaration.resolve(project) : undefined;
};

const entrySymbol = ({
  checker,
  node,
}: {
  readonly checker: TsChecker;
  readonly node: Node;
}) => {
  if (isShorthandPropertyAssignment(node)) {
    return checker.getShorthandAssignmentValueSymbol(node);
  }
  if (isPropertyAssignment(node) && isIdentifier(node.initializer)) {
    return checker.getSymbolAtLocation(node.initializer);
  }
  return Promise.resolve(undefined);
};

/**
 * An edge whose target is a type the walk met before the class declaring it.
 *
 * Requirements are read off `Layer` and `Effect` type arguments, which the walk
 * reaches in whatever order the file list happens to be in. Resolving them
 * where they are found would need a second pass over the whole repo; recording
 * them and resolving once the declaration table is complete costs one array.
 */
export interface PendingEdge {
  readonly kind: EdgeKind;
  readonly source: string;
  readonly target: TypeRef;
  /** Which node the target is, when it has to be invented for an external type. */
  readonly targetKind: "service" | "error";
}

/** What every visitor needs, whichever project it is walking. */
export interface WalkShared {
  readonly builder: GraphBuilder;
  /** `${lowercased declaration path}|${name}` to node id, for classes already seen. */
  readonly declared: Map<string, string>;
  /** Records something the walk declined to draw. Never throws. */
  readonly note: (entry: Unresolved) => void;
  /** The package node id owning a repo-relative file. */
  readonly packageIdFor: (file: string) => string;
  readonly pending: PendingEdge[];
  readonly root: string;
}

/** {@link WalkShared} bound to the project currently being walked. */
export interface WalkContext extends WalkShared {
  readonly checker: TsChecker;
  readonly project: TsProject;
  /**
   * Records an edge to whatever one channel member turns out to name. The
   * target is resolved after the walk, against the finished declaration table.
   */
  readonly reference: (options: {
    readonly kind: EdgeKind;
    readonly member: TsType;
    readonly source: string;
    readonly targetKind: PendingEdge["targetKind"];
  }) => Promise<void>;
}
