/**
 * Orchestration: open a checker session, walk every workspace source file once,
 * and fold what the checker says into one {@link AtlasGraph}.
 *
 * The walk is a single pass. Requirements name types the walk may not have
 * classified yet, so they are recorded as pending references and resolved at
 * the end against the finished declaration table — one array instead of a
 * second pass over every file.
 */

import { SymbolFlags } from "typescript/unstable/async";
import {
  type AtlasEdge,
  type AtlasGraph,
  createGraphBuilder,
  EXTERNAL_PACKAGE_ID,
  type GraphBuilder,
  nodeId,
  type Unresolved,
} from "../graph";
import {
  describeMember,
  isChannelMarker,
  isDrawableExternal,
  safe,
  type TypeRef,
  typeText,
} from "./effect";
import { visitLayer } from "./layers";
import { packageIdIn, readPackages } from "./packages";
import { visitClass } from "./services";
import {
  discoverConfigs,
  openSession,
  type PendingEdge,
  projectSourceFiles,
  type TsProject,
  type TsSymbol,
  type WalkContext,
  type WalkShared,
} from "./session";

export interface ExtractOptions {
  /**
   * Absolute tsconfig paths to open. Discovered under `root` when absent —
   * one per workspace, and never the root config.
   */
  readonly configs?: readonly string[];
  /** Told how many projects the checker opened, and how long that took. */
  readonly onSnapshot?: (info: SnapshotInfo) => void;
  /** Absolute path of the tree to map. The repo root in normal use. */
  readonly root: string;
}

export interface SnapshotInfo {
  readonly ms: number;
  readonly projects: number;
}

/** A declaration that belongs to a dependency, or to a test. */
const NOT_OURS = /\/node_modules\/|\.test\.tsx?$/;

/** Builds the graph for one tree. The single entry point of the extractor. */
export const extractGraph = async ({
  root,
  configs,
  onSnapshot,
}: ExtractOptions): Promise<AtlasGraph> => {
  const started = Date.now();
  const builder = createGraphBuilder();
  const unresolved: Unresolved[] = [];
  const { dependencies, nodes: packageNodes } = await readPackages(root);
  for (const node of packageNodes) {
    builder.addNode(node);
  }
  for (const dependency of dependencies) {
    builder.addEdge({ kind: "depends", ...dependency });
  }

  const shared: WalkShared = {
    builder,
    declared: new Map(),
    note: (entry) => unresolved.push(entry),
    packageIdFor: packageIdIn(packageNodes),
    pending: [],
    root,
  };

  const totals = await walkProjects({
    configs: configs ?? (await discoverConfigs(root)),
    onSnapshot,
    root,
    shared,
  });

  resolvePending(shared);
  linkDeclares(builder);
  deriveNeeds(builder);
  for (const entry of unresolved) {
    builder.addUnresolved(entry);
  }
  return builder.build({
    root,
    totals: { ...totals, ms: Date.now() - started },
  });
};

const walkProjects = async ({
  configs,
  onSnapshot,
  root,
  shared,
}: {
  readonly configs: readonly string[];
  readonly onSnapshot?: (info: SnapshotInfo) => void;
  readonly root: string;
  readonly shared: WalkShared;
}) => {
  const session = await openSession({ configs, root });
  onSnapshot?.({ ms: session.ms, projects: session.projects.length });
  // One file may sit in five programs, and one symbol may be re-exported by
  // three barrels. Both sets are global to the walk for that reason.
  const walked = new Set<string>();
  const classified = new Set<string>();
  let files = 0;
  let exports = 0;
  try {
    for (const project of session.projects) {
      const ctx = contextFor({ project, shared });
      for (const fileName of await projectSourceFiles(project)) {
        if (walked.has(fileName)) {
          continue;
        }
        walked.add(fileName);
        files += 1;
        // biome-ignore lint/performance/noAwaitInLoops: one checker server, one question at a time
        exports += await visitFile({ classified, ctx, fileName });
      }
    }
  } finally {
    await session.close();
  }
  return { exports, files };
};

const contextFor = ({
  project,
  shared,
}: {
  readonly project: TsProject;
  readonly shared: WalkShared;
}): WalkContext => {
  const { checker } = project;
  return {
    ...shared,
    checker,
    project,
    reference: async ({ kind, member, source, targetKind }) => {
      // A type parameter is a hole in a generic signature, not a requirement:
      // `Database.transaction<A, E, R>` fails with whatever it is handed.
      if (member.isTypeParameter()) {
        return;
      }
      const ref = await describeMember({ checker, member });
      if (ref) {
        shared.pending.push({ kind, source, target: ref, targetKind });
        return;
      }
      shared.note({
        detail: await typeText(checker, member),
        reason: "no-symbol",
        where: source,
      });
    },
  };
};

/** Classifies every export of one file. Returns how many symbols it looked at. */
const visitFile = async ({
  classified,
  ctx,
  fileName,
}: {
  readonly classified: Set<string>;
  readonly ctx: WalkContext;
  readonly fileName: string;
}) => {
  const file = await ctx.project.program.getSourceFile(fileName);
  const moduleSymbol = file && (await ctx.checker.getSymbolAtLocation(file));
  if (!moduleSymbol) {
    return 0;
  }
  const symbols = await safe(
    () => ctx.checker.getExportsOfModule(moduleSymbol),
    (detail) => ctx.note({ detail, reason: "checker-error", where: fileName }),
    fileName
  );
  let seen = 0;
  for (const symbol of symbols ?? []) {
    // A barrel exports an alias; the node belongs to the defining declaration,
    // which is what stops `repositoriesLayer` appearing once per re-export.
    const target =
      // biome-ignore lint/suspicious/noBitwiseOperators: SymbolFlags is a bit set, and this is how one is tested
      symbol.flags & SymbolFlags.Alias
        ? // biome-ignore lint/performance/noAwaitInLoops: one checker server, one question at a time
          await ctx.checker.getAliasedSymbol(symbol)
        : symbol;
    const [declaration] = target.declarations;
    if (!declaration || NOT_OURS.test(declaration.path)) {
      continue;
    }
    const key = `${declaration.path}|${target.name}`;
    if (classified.has(key)) {
      continue;
    }
    classified.add(key);
    seen += 1;
    await visitExport({ ctx, symbol: target });
  }
  return seen;
};

const visitExport = async ({
  ctx,
  symbol,
}: {
  readonly ctx: WalkContext;
  readonly symbol: TsSymbol;
}) => {
  const where = `${symbol.declarations[0]?.path ?? "?"}#${symbol.name}`;
  const type = await safe(
    () => ctx.checker.getTypeOfSymbol(symbol),
    (detail) => ctx.note({ detail, reason: "checker-error", where }),
    where
  );
  if (!type) {
    ctx.note({ detail: symbol.name, reason: "no-type", where });
    return;
  }
  if (
    // biome-ignore lint/suspicious/noBitwiseOperators: SymbolFlags is a bit set, and this is how one is tested
    symbol.flags & SymbolFlags.Class &&
    (await visitClass({ ctx, symbol, type }))
  ) {
    return;
  }
  await visitLayer({
    ctx,
    name: symbol.name,
    staticMember: false,
    symbol,
    type,
  });
};

/** The external node a requirement stands for, invented on first sight. */
const addExternal = ({
  builder,
  edge,
}: {
  readonly builder: GraphBuilder;
  readonly edge: PendingEdge;
}) => {
  const { name, text } = edge.target;
  if (edge.targetKind === "error") {
    const id = nodeId.errorByTag(name);
    builder.addNode({
      id,
      kind: "error",
      label: name,
      origin: "external",
      pkg: EXTERNAL_PACKAGE_ID,
      typeText: text,
    });
    return id;
  }
  const id = nodeId.externalService(name);
  builder.addNode({
    id,
    kind: "service",
    label: name,
    memberCount: 0,
    origin: "external",
    pkg: EXTERNAL_PACKAGE_ID,
    tags: [],
    typeText: text,
  });
  return id;
};

/**
 * Turns every recorded reference into an edge, an external node, or an
 * `unresolved` entry. A requirement the checker states as
 * `Service<"atm", "artifacts">` — the group markers `HttpApiGroup` puts in a
 * handler layer's requirements — is none of the first two: it names a shape
 * the framework assembles, and drawing it invents a service.
 */
const resolvePending = ({ builder, declared, note, pending }: WalkShared) => {
  for (const edge of pending) {
    const known = declared.get(edge.target.declPath);
    if (known) {
      builder.addEdge({ kind: edge.kind, source: edge.source, target: known });
      continue;
    }
    if (isDrawableExternal(edge.target)) {
      builder.addEdge({
        kind: edge.kind,
        source: edge.source,
        target: addExternal({ builder, edge }),
      });
      continue;
    }
    if (isChannelMarker(edge.target)) {
      continue;
    }
    note({
      detail: describeUnresolved(edge.target),
      reason: "opaque-requirement",
      where: edge.source,
    });
  }
};

const describeUnresolved = (ref: TypeRef) =>
  ref.text === ref.name ? ref.name : `${ref.name}: ${ref.text}`;

/** One `declares` edge per node the walk placed inside a workspace package. */
const linkDeclares = (builder: GraphBuilder) => {
  for (const node of builder.nodes()) {
    if (node.kind === "package" || !node.src) {
      continue;
    }
    if (builder.hasNode(node.pkg)) {
      builder.addEdge({ kind: "declares", source: node.pkg, target: node.id });
    }
  }
};

const collect = (edges: readonly AtlasEdge[], kind: AtlasEdge["kind"]) => {
  const bySource = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== kind) {
      continue;
    }
    const targets = bySource.get(edge.source) ?? new Set<string>();
    targets.add(edge.target);
    bySource.set(edge.source, targets);
  }
  return bySource;
};

/**
 * The one edge the checker never states, and the only one over which the
 * default view is readable: `S needs T` when a layer both provides `S` and
 * requires `T`, and when a method of `S` has `T` in its requirements.
 */
const deriveNeeds = (builder: GraphBuilder) => {
  const edges = builder.edges();
  const provided = collect(edges, "provides");
  const required = collect(edges, "requires");
  for (const [layer, services] of provided) {
    for (const service of services) {
      for (const target of required.get(layer) ?? []) {
        if (service !== target) {
          builder.addEdge({ kind: "needs", source: service, target });
        }
      }
    }
  }
  for (const edge of edges) {
    if (edge.kind !== "method-requires") {
      continue;
    }
    const method = builder.getNode(edge.source);
    if (method?.kind === "method" && method.service !== edge.target) {
      builder.addEdge({
        kind: "needs",
        source: method.service,
        target: edge.target,
      });
    }
  }
};
