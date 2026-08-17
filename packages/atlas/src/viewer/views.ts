/**
 * The three views — packages, services, methods — plus the workspace filter,
 * the edge-kind toggles, focus and compare. Each view is a filtered projection
 * of the one graph; nothing here fetches, and nothing here touches the DOM.
 */

import {
  type AtlasGraph,
  EDGE_KINDS,
  type EdgeKind,
  EXTERNAL_PACKAGE_ID,
} from "../graph";

export const VIEWS = ["packages", "services", "methods"] as const;

export type ViewName = (typeof VIEWS)[number];

/** What the top bar currently says, in one value. */
export interface ViewState {
  /** A second focused node, so the panel can diff two neighbourhoods. */
  readonly compare: string | null;
  readonly edgeKinds: ReadonlySet<EdgeKind>;
  /** Isolate this node's transitive closure over the enabled edge kinds. */
  readonly focus: string | null;
  /** Package node ids left visible by the workspace filter. */
  readonly packages: ReadonlySet<string>;
  readonly selected: string | null;
  /** Services view: draw `FileSystem`, `PgClient` and the rest of node_modules. */
  readonly showExternal: boolean;
  /** Services view: draw layers with `provides`/`requires` instead of `needs`. */
  readonly showLayers: boolean;
  readonly view: ViewName;
}

/**
 * One view's answer, in two layers.
 *
 * `nodeIds`/`edgeIds` is the element set the canvas holds; `shownNodeIds`/
 * `shownEdgeIds` is what focus leaves showing of it, and the two are equal
 * when nothing is focused. Keeping them apart is what lets focus hide rather
 * than redraw: the map stays where it was and the camera moves to the part
 * being asked about.
 */
export interface Projection {
  /** Package nodes hold the rest as children. */
  readonly compound: boolean;
  readonly edgeIds: ReadonlySet<string>;
  /** Shown instead of an empty canvas, e.g. the methods view with no service. */
  readonly hint: string | null;
  readonly nodeIds: ReadonlySet<string>;
  readonly shownEdgeIds: ReadonlySet<string>;
  readonly shownNodeIds: ReadonlySet<string>;
}

/** Every edge kind on, bar `declares` — it doubles every compound membership. */
export const defaultEdgeKinds = (): ReadonlySet<EdgeKind> =>
  new Set(EDGE_KINDS.filter((kind) => kind !== "declares"));

/** The initial state: the packages view, everything visible. */
export const initialState = (graph: AtlasGraph): ViewState => ({
  compare: null,
  edgeKinds: defaultEdgeKinds(),
  focus: null,
  packages: new Set(
    graph.nodes.filter((n) => n.kind === "package").map((n) => n.id)
  ),
  selected: null,
  showExternal: false,
  showLayers: false,
  view: "packages",
});

const indexNodes = (graph: AtlasGraph) =>
  new Map(graph.nodes.map((node) => [node.id, node] as const));

/** The service a methods view should draw, given whatever is selected. */
export const methodSubject = ({
  graph,
  selected,
}: {
  readonly graph: AtlasGraph;
  readonly selected: string | null;
}) => {
  if (!selected) {
    return null;
  }
  const node = indexNodes(graph).get(selected);
  if (!node) {
    return null;
  }
  if (node.kind === "service") {
    return node.id;
  }
  return node.kind === "method" ? node.service : null;
};

const baseNodes = ({
  graph,
  state,
}: {
  readonly graph: AtlasGraph;
  readonly state: ViewState;
}): { readonly ids: Set<string>; readonly hint: string | null } => {
  const ids = new Set<string>();

  if (state.view === "packages") {
    for (const node of graph.nodes) {
      // `pkg:external` is a bucket, not a workspace: it holds no children in
      // this view and has no `depends` edge, so it draws as an orphan box.
      if (node.kind === "package" && node.id !== EXTERNAL_PACKAGE_ID) {
        ids.add(node.id);
      }
    }
    return { hint: null, ids };
  }

  if (state.view === "services") {
    return serviceNodes({ graph, state });
  }

  return methodNodes({ graph, state });
};

/** Every service, or — with layers on — how the selected one is built. */
const serviceNodes = ({
  graph,
  state,
}: {
  readonly graph: AtlasGraph;
  readonly state: ViewState;
}) => {
  if (state.showLayers) {
    return layerNodes({ graph, state });
  }
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    // Thirteen of the repo's 62 services are `FileSystem`, `PgClient` and the
    // like. At rest they add a column and a long edge from almost every
    // service, and the answer they give — "everything touches the filesystem"
    // — is not the one this view is for.
    const drawn =
      node.kind === "service" &&
      (state.showExternal || node.origin === "workspace");
    if (drawn) {
      ids.add(node.id);
    }
  }
  return { hint: null, ids };
};

/**
 * What builds one service: the layers that provide it, and what those require.
 *
 * Every layer at once puts every service and every layer on one canvas, which
 * at this repo's size draws labels a few pixels tall — a picture of a hairball
 * rather than an answer. The layers that merely *require* the subject are in
 * the panel, where a list of fifteen reads and a column of fifteen does not.
 */
const layerNodes = ({
  graph,
  state,
}: {
  readonly graph: AtlasGraph;
  readonly state: ViewState;
}) => {
  const subject = layerSubject({
    graph,
    selected: state.focus ?? state.selected,
  });
  if (!subject) {
    return {
      hint: "Select a service, then show layers, to see what builds it and what that needs.",
      ids: new Set<string>(),
    };
  }
  const byId = indexNodes(graph);
  // Every layer that names the subject, then what those layers require. Their
  // other outputs are left out on purpose: `repositoriesLayer` provides twenty
  // repositories, and drawing all twenty answers a question nobody asked.
  const itself = byId.get(subject)?.kind === "layer";
  const layers = new Set<string>(itself ? [subject] : []);
  for (const edge of graph.edges) {
    if (edge.kind === "provides" && edge.target === subject) {
      layers.add(edge.source);
    }
  }
  const reached = new Set<string>([subject, ...layers]);
  for (const edge of graph.edges) {
    const out =
      layers.has(edge.source) &&
      (edge.kind === "requires" || (itself && edge.kind === "provides"));
    if (out) {
      reached.add(edge.target);
    }
  }
  const ids = new Set(
    [...reached].filter(
      (id) =>
        id === subject ||
        state.showExternal ||
        byId.get(id)?.origin === "workspace"
    )
  );
  return { hint: null, ids };
};

/** The service or layer a layer view should be built around. */
const layerSubject = ({
  graph,
  selected,
}: {
  readonly graph: AtlasGraph;
  readonly selected: string | null;
}) => {
  if (!selected) {
    return null;
  }
  const node = indexNodes(graph).get(selected);
  if (!node) {
    return null;
  }
  if (node.kind === "service" || node.kind === "layer") {
    return node.id;
  }
  return node.kind === "method" ? node.service : null;
};

/** One service, its effectful methods, and what those require and raise. */
const methodNodes = ({
  graph,
  state,
}: {
  readonly graph: AtlasGraph;
  readonly state: ViewState;
}) => {
  const ids = new Set<string>();
  const subject = methodSubject({ graph, selected: state.selected });
  if (!subject) {
    return {
      hint: "Select a service to see its methods, what they require and how they fail.",
      ids,
    };
  }
  ids.add(subject);
  for (const edge of graph.edges) {
    if (edge.kind === "has-method" && edge.source === subject) {
      ids.add(edge.target);
    }
  }
  for (const edge of graph.edges) {
    const fromMethod =
      ids.has(edge.source) &&
      (edge.kind === "method-requires" || edge.kind === "fails-with");
    if (fromMethod) {
      ids.add(edge.target);
    }
  }
  return { hint: null, ids };
};

/** Whether `show layers` has something to scope itself to. */
export const layersAvailable = ({
  graph,
  state,
}: {
  readonly graph: AtlasGraph;
  readonly state: ViewState;
}) => layerSubject({ graph, selected: state.focus ?? state.selected }) !== null;

/** Edge kinds this view draws at all, before the user's toggles mask them. */
export const availableEdgeKinds = (state: ViewState): readonly EdgeKind[] => {
  if (state.view === "packages") {
    return ["depends"];
  }
  if (state.view === "services") {
    return state.showLayers
      ? ["provides", "requires", "declares"]
      : ["needs", "declares"];
  }
  return ["has-method", "method-requires", "fails-with", "declares"];
};

const closure = ({
  graph,
  from,
  nodeIds,
  edgeIds,
  follow = "both",
}: {
  readonly graph: AtlasGraph;
  readonly from: string;
  readonly nodeIds: ReadonlySet<string>;
  readonly edgeIds: ReadonlySet<string>;
  /** `out` walks with the arrows only — what this node pulls in. */
  readonly follow?: "both" | "out";
}) => {
  const out = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = out.get(a);
    if (list) {
      list.push(b);
    } else {
      out.set(a, [b]);
    }
  };
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      link(edge.source, edge.target);
      if (follow === "both") {
        link(edge.target, edge.source);
      }
    }
  }

  const seen = new Set<string>();
  // The queue is appended to while it is walked; a `for...of` over an array
  // reads it live, which is the breadth-first walk without an index.
  const queue = nodeIds.has(from) ? [from] : [];
  for (const id of queue) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    for (const next of out.get(id) ?? []) {
      if (!seen.has(next)) {
        queue.push(next);
      }
    }
  }
  return seen;
};

const keepEdges = ({
  graph,
  nodeIds,
  kinds,
}: {
  readonly graph: AtlasGraph;
  readonly nodeIds: ReadonlySet<string>;
  readonly kinds: ReadonlySet<EdgeKind>;
}) => {
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    const ok =
      kinds.has(edge.kind) &&
      nodeIds.has(edge.source) &&
      nodeIds.has(edge.target);
    if (ok) {
      edgeIds.add(edge.id);
    }
  }
  return edgeIds;
};

/** Which ids the canvas should hold, for one graph and one bar of controls. */
export const project = ({
  graph,
  state,
}: {
  readonly graph: AtlasGraph;
  readonly state: ViewState;
}): Projection => {
  const compound = state.view !== "packages";
  const { ids, hint } = baseNodes({ graph, state });
  const byId = indexNodes(graph);

  const visible = new Set<string>();
  for (const id of ids) {
    const node = byId.get(id);
    if (node && state.packages.has(node.pkg)) {
      visible.add(id);
    }
  }

  const kinds = new Set(
    availableEdgeKinds(state).filter((kind) => state.edgeKinds.has(kind))
  );
  const nodeIds = visible;
  const withParents = (chosen: Set<string>) => {
    if (!compound) {
      return chosen;
    }
    for (const id of [...chosen]) {
      const node = byId.get(id);
      if (node && node.kind !== "package" && state.packages.has(node.pkg)) {
        chosen.add(node.pkg);
      }
    }
    return chosen;
  };
  withParents(nodeIds);
  const edgeIds = keepEdges({ graph, kinds, nodeIds });

  if (!state.focus) {
    return {
      compound,
      edgeIds,
      hint,
      nodeIds,
      shownEdgeIds: edgeIds,
      shownNodeIds: nodeIds,
    };
  }
  const reached = withParents(
    closure({ edgeIds, from: state.focus, graph, nodeIds })
  );
  return {
    compound,
    edgeIds,
    hint,
    nodeIds,
    shownEdgeIds: keepEdges({ graph, kinds, nodeIds: reached }),
    shownNodeIds: reached,
  };
};

/** Three counted lists: reached only from A, only from B, or from both. */
export const compareClosures = ({
  graph,
  state,
  a,
  b,
}: {
  readonly graph: AtlasGraph;
  readonly state: ViewState;
  readonly a: string;
  readonly b: string;
}) => {
  const full = project({
    graph,
    state: { ...state, compare: null, focus: null },
  });
  // Downstream only: the question compare answers is what one node pulls in
  // that the other does not, and an undirected walk returns the same
  // connected component for both.
  const reach = (from: string) =>
    closure({
      edgeIds: full.shownEdgeIds,
      follow: "out",
      from,
      graph,
      nodeIds: full.shownNodeIds,
    });
  const left = reach(a);
  const right = reach(b);
  const byName = (one: string, two: string) => one.localeCompare(two);
  const only = (x: ReadonlySet<string>, y: ReadonlySet<string>) =>
    [...x].filter((id) => !y.has(id)).sort(byName);
  return {
    both: [...left].filter((id) => right.has(id)).sort(byName),
    onlyA: only(left, right),
    onlyB: only(right, left),
  };
};
