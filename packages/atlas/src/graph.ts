/**
 * The one shape the extractor writes and the viewer reads.
 *
 * Everything in this file is data: no checker, no DOM, no Effect. The extractor
 * builds an {@link AtlasGraph} out of the TypeScript checker and serialises it
 * to `graph.json`; the viewer receives exactly that value on
 * `window.__ATLAS__` and draws it. Neither side may widen the model without the
 * other seeing the change here first, which is why ids are built only through
 * {@link nodeId} and {@link edgeId} — a hand-written string is how the two
 * sides silently stop agreeing on what a node is.
 */

/** Node kinds, in the order the viewer ranks them left to right. */
export const NODE_KINDS = [
  "package",
  "service",
  "layer",
  "method",
  "error",
] as const;

/**
 * Edge kinds. All but `needs` are read off the checker; `needs` is derived by
 * the extractor — see {@link AtlasEdge}.
 */
export const EDGE_KINDS = [
  "depends",
  "declares",
  "provides",
  "requires",
  "needs",
  "has-method",
  "method-requires",
  "fails-with",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** Where a node was declared, as a person would type it into an editor. */
export interface SourceLoc {
  /** 1-based, same correction as {@link SourceLoc.line}. */
  readonly column: number;
  /** Repo-relative, real casing: `packages/db/src/store.ts`. Never a lowercased `Path`. */
  readonly file: string;
  /** 1-based. The checker reports 0-based; the extractor adds one. */
  readonly line: number;
}

/** The fields every node carries, whatever its kind. */
interface NodeBase {
  /** Built by {@link nodeId}. Unique across the whole graph. */
  readonly id: string;
  /** Short display name. */
  readonly label: string;
  readonly origin: "workspace" | "external";
  /** Owning package node id; `pkg:external` for anything under `node_modules`. */
  readonly pkg: string;
  /** Absent for external nodes and for package nodes. */
  readonly src?: SourceLoc;
  /** `typeToString` with `NoTruncation`. Display only — never parsed. */
  readonly typeText?: string;
}

/** A workspace directory with a `package.json`, or the single external bucket. */
export interface PackageNode extends NodeBase {
  /** Repo-relative, e.g. `packages/db`. Empty string for external. */
  readonly dir: string;
  /** Drives left-to-right rank in the packages view; `app` ranks first. */
  readonly group: "app" | "package" | "external";
  readonly kind: "package";
  /** e.g. `@workspace/db`. */
  readonly npmName: string;
}

/** A `Context.Service` class, or an external requirement seen in a type argument. */
export interface ServiceNode extends NodeBase {
  /** The `Context.Service` key literal, e.g. `@workspace/db/WorkspaceRepo`. */
  readonly key?: string;
  readonly kind: "service";
  /** All members, including the plain-data ones that get no method node. */
  readonly memberCount: number;
  /** Coarse role, e.g. `repository`, `middleware`. */
  readonly tags: readonly string[];
}

/** A `Layer`, either a module-level constant or a static on a service class. */
export interface LayerNode extends NodeBase {
  /**
   * Built with `Layer.provide`, `Layer.provideMerge` or `Layer.unwrap`. The
   * type keeps only what survives composition, so the inner layers this one is
   * assembled from are absent from the graph — the panel says so rather than
   * letting `provides 8` read as the whole answer.
   */
  readonly composed: boolean;
  readonly kind: "layer";
  /** A factory — `(opts) => Layer<...>`. Must be called once, not per use. */
  readonly parameterized: boolean;
  /** `Service.layer` rather than a module export. */
  readonly staticMember: boolean;
}

/** An effectful member of a service. Plain-data members produce no node. */
export interface MethodNode extends NodeBase {
  readonly kind: "method";
  /** Owning service node id. */
  readonly service: string;
}

/** A `Schema.TaggedErrorClass` subclass. */
export interface ErrorNode extends NodeBase {
  readonly kind: "error";
  /** The `_tag` literal, e.g. `Sandbox.DaemonUnreachable`. */
  readonly tag?: string;
}

export type AtlasNode =
  | PackageNode
  | ServiceNode
  | LayerNode
  | MethodNode
  | ErrorNode;

/**
 * A directed edge. `needs` is the one kind the checker never states: the
 * extractor emits `S needs T` when a layer both provides `S` and requires `T`,
 * and when a method of `S` has `T` in its `R`. It is what makes the services
 * view readable at ~50 nodes instead of ~170.
 */
export interface AtlasEdge {
  /** Built by {@link edgeId}: `${kind}:${source}->${target}`. */
  readonly id: string;
  readonly kind: EdgeKind;
  readonly source: string;
  readonly target: string;
}

/**
 * Something the walk saw and chose not to draw. Never fatal — an
 * unclassifiable symbol is skipped and recorded here, so a growing count is
 * the signal that the extractor has drifted from the codebase.
 */
export interface Unresolved {
  readonly detail: string;
  readonly reason:
    | "no-type"
    | "no-symbol"
    | "opaque-requirement"
    | "checker-error";
  /** A node id, or the file the walk was in when it gave up. */
  readonly where: string;
}

/** The whole map: one JSON document, written by the CLI, read by the viewer. */
export interface AtlasGraph {
  readonly edges: readonly AtlasEdge[];
  /** ISO timestamp. */
  readonly generatedAt: string;
  readonly nodes: readonly AtlasNode[];
  /** Absolute repo root, so the viewer can build editor links. */
  readonly root: string;
  /** One count per node kind and edge kind, plus `files`, `exports` and `ms`. */
  readonly stats: Readonly<
    Record<NodeKind | EdgeKind | "files" | "exports" | "ms", number>
  >;
  readonly unresolved: readonly Unresolved[];
  readonly version: 1;
}

/** The package node every `node_modules` declaration is attributed to. */
export const EXTERNAL_PACKAGE_ID = "pkg:external";

/** Where a symbol was declared, as the id builders want it. */
interface Declaration {
  /** Repo-relative, real-cased file path — the same string as {@link SourceLoc.file}. */
  readonly file: string;
  /** The exported symbol's name. */
  readonly name: string;
}

/**
 * The only sanctioned way to spell a node id.
 *
 * Two nodes are the same node when their ids match, so every producer has to
 * agree on the spelling down to the separator. Prefer the identity-bearing
 * builder when the information is there — a service with a `Context.Service`
 * key is `serviceByKey`, because the key survives the file being moved.
 */
export const nodeId = {
  /** `err:packages/sandbox/src/errors.ts#DaemonUnreachable` — no `_tag` found. */
  errorByDeclaration: ({ file, name }: Declaration) => `err:${file}#${name}`,
  /** `err:Sandbox.DaemonUnreachable` — the `_tag` literal. */
  errorByTag: (tag: string) => `err:${tag}`,
  /** `svc:ext/FileSystem` — a requirement declared under `node_modules`. */
  externalService: (name: string) => `svc:ext/${name}`,
  /** `layer:packages/db/src/store.ts#storeLayer`, or `...#WorkspaceRepo.layer` for a static. */
  layer: ({ file, name }: Declaration) => `layer:${file}#${name}`,
  /** `method:svc:@workspace/db/TaskRepo.transition` */
  method: ({
    service,
    name,
  }: {
    readonly service: string;
    readonly name: string;
  }) => `method:${service}.${name}`,
  /** `pkg:@workspace/db` */
  package: (npmName: string) => `pkg:${npmName}`,
  /** `svc:packages/db/src/store.ts#Store` — a service class with no key. */
  serviceByDeclaration: ({ file, name }: Declaration) => `svc:${file}#${name}`,
  /** `svc:@workspace/db/WorkspaceRepo` — the `Context.Service` key literal. */
  serviceByKey: (key: string) => `svc:${key}`,
} as const;

/**
 * The id of an edge, which is a function of its three parts alone. Two edges
 * of the same kind between the same pair are one edge.
 */
export const edgeId = ({
  kind,
  source,
  target,
}: {
  readonly kind: EdgeKind;
  readonly source: string;
  readonly target: string;
}) => `${kind}:${source}->${target}`;

/** The counts the extractor measures itself, rather than deriving from the graph. */
export interface GraphTotals {
  /** Exported symbols classified. */
  readonly exports: number;
  /** Source files walked. */
  readonly files: number;
  /** Wall-clock milliseconds for the whole extraction. */
  readonly ms: number;
}

/** Accumulates nodes and edges, first write wins, and seals them into a graph. */
export interface GraphBuilder {
  /**
   * Adds an edge, deriving its id from the three parts. Adding the same triple
   * twice is a no-op. Endpoints are not checked here: an edge may be recorded
   * before the node it points at exists.
   */
  readonly addEdge: (edge: {
    readonly kind: EdgeKind;
    readonly source: string;
    readonly target: string;
  }) => AtlasEdge;
  /**
   * Adds a node unless its id is already taken, and returns the node now under
   * that id — the existing one when it was a duplicate. First write wins, so a
   * richer description must be added before a thinner one.
   */
  readonly addNode: <N extends AtlasNode>(node: N) => AtlasNode;
  /** Records something the walk declined to draw. Duplicates are kept. */
  readonly addUnresolved: (entry: Unresolved) => void;
  /**
   * Seals the builder into an {@link AtlasGraph}. Nodes and edges come out
   * sorted by id so that two runs over an unchanged tree produce a byte-equal
   * `graph.json` and a diff reads. `stats` is the per-kind counts plus the
   * totals passed in.
   */
  readonly build: (options: {
    /** Absolute repo root. */
    readonly root: string;
    readonly totals: GraphTotals;
    /** ISO timestamp; defaults to now. */
    readonly generatedAt?: string;
  }) => AtlasGraph;
  /** Every edge added so far, in insertion order. */
  readonly edges: () => readonly AtlasEdge[];
  /** The node under this id, or `undefined`. */
  readonly getNode: (id: string) => AtlasNode | undefined;
  /** True when a node with this id has been added. */
  readonly hasNode: (id: string) => boolean;
  /** Every node added so far, in insertion order. */
  readonly nodes: () => readonly AtlasNode[];
}

const zeroedStats = () => {
  const stats: Record<string, number> = { exports: 0, files: 0, ms: 0 };
  for (const kind of NODE_KINDS) {
    stats[kind] = 0;
  }
  for (const kind of EDGE_KINDS) {
    stats[kind] = 0;
  }
  return stats as Record<
    NodeKind | EdgeKind | "files" | "exports" | "ms",
    number
  >;
};

// Code-unit order rather than `localeCompare`, so the same tree sorts the same
// way whatever locale the run happens under and `graph.json` stays byte-equal.
const byId = (a: { readonly id: string }, b: { readonly id: string }) => {
  if (a.id < b.id) {
    return -1;
  }
  if (a.id > b.id) {
    return 1;
  }
  return 0;
};

/** Creates an empty {@link GraphBuilder}. */
export const createGraphBuilder = (): GraphBuilder => {
  const nodes = new Map<string, AtlasNode>();
  const edges = new Map<string, AtlasEdge>();
  const unresolved: Unresolved[] = [];

  return {
    addEdge: ({ kind, source, target }) => {
      const id = edgeId({ kind, source, target });
      const existing = edges.get(id);
      if (existing) {
        return existing;
      }
      const edge: AtlasEdge = { id, kind, source, target };
      edges.set(id, edge);
      return edge;
    },
    addNode: (node) => {
      const existing = nodes.get(node.id);
      if (existing) {
        return existing;
      }
      nodes.set(node.id, node);
      return node;
    },
    addUnresolved: (entry) => {
      unresolved.push(entry);
    },
    build: ({ root, totals, generatedAt }) => {
      const stats = zeroedStats();
      stats.files = totals.files;
      stats.exports = totals.exports;
      stats.ms = totals.ms;
      for (const node of nodes.values()) {
        stats[node.kind] += 1;
      }
      for (const edge of edges.values()) {
        stats[edge.kind] += 1;
      }
      return {
        edges: [...edges.values()].sort(byId),
        generatedAt: generatedAt ?? new Date().toISOString(),
        nodes: [...nodes.values()].sort(byId),
        root,
        stats,
        unresolved: [...unresolved],
        version: 1,
      };
    },
    edges: () => [...edges.values()],
    getNode: (id) => nodes.get(id),
    hasNode: (id) => nodes.has(id),
    nodes: () => [...nodes.values()],
  };
};
