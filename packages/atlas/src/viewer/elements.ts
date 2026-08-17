/**
 * Graph to cytoscape: elements, stylesheet, and the colour of each kind and
 * origin.
 *
 * Colour carries kind, shape carries "is this an error", and a dashed border
 * carries "this lives in node_modules". Nothing here decides what is drawn —
 * `views.ts` picks the ids and this file turns them into elements.
 */

import type { ElementDefinition, StylesheetJson } from "cytoscape";
import type { AtlasGraph, AtlasNode, EdgeKind, NodeKind } from "../graph";

/** One colour per node kind. Dark background, so every hue is a light one. */
export const KIND_COLOR: Readonly<Record<NodeKind, string>> = {
  error: "#f87171",
  layer: "#fbbf24",
  method: "#a78bfa",
  package: "#7dd3fc",
  service: "#34d399",
};

/** One colour per edge kind, matching the node kind each one points at. */
export const EDGE_COLOR: Readonly<Record<EdgeKind, string>> = {
  declares: "#3f4650",
  depends: "#7dd3fc",
  "fails-with": "#f87171",
  "has-method": "#a78bfa",
  "method-requires": "#38bdf8",
  needs: "#38bdf8",
  provides: "#34d399",
  requires: "#fbbf24",
};

const EXTERNAL_COLOR = "#8a94a6";

const DASHED: readonly EdgeKind[] = ["requires", "method-requires", "declares"];

/** Human wording for a kind, used by the legend and the panel badge. */
export const KIND_LABEL: Readonly<Record<NodeKind, string>> = {
  error: "error",
  layer: "layer",
  method: "method",
  package: "package",
  service: "service",
};

const colorOf = (node: AtlasNode) =>
  node.origin === "external" ? EXTERNAL_COLOR : KIND_COLOR[node.kind];

const classesOf = (node: AtlasNode, compound: boolean) => {
  const classes = [`k-${node.kind}`];
  if (node.origin === "external") {
    classes.push("external");
  }
  if (node.kind === "package" && compound) {
    classes.push("group");
  }
  return classes.join(" ");
};

/** The subset of a node the browser needs; everything else stays in the graph. */
const dataOf = (node: AtlasNode, parent: string | undefined) => ({
  color: colorOf(node),
  id: node.id,
  kind: node.kind,
  label: node.label,
  origin: node.origin,
  ...(parent ? { parent } : {}),
});

/** The elements for one projection: the chosen nodes, then the chosen edges. */
export const toElements = ({
  graph,
  nodeIds,
  edgeIds,
  compound,
}: {
  readonly graph: AtlasGraph;
  readonly nodeIds: ReadonlySet<string>;
  readonly edgeIds: ReadonlySet<string>;
  /** True when package nodes hold the rest as children. */
  readonly compound: boolean;
}): ElementDefinition[] => {
  const elements: ElementDefinition[] = [];

  for (const node of graph.nodes) {
    if (!nodeIds.has(node.id)) {
      continue;
    }
    const parent =
      compound && node.kind !== "package" && nodeIds.has(node.pkg)
        ? node.pkg
        : undefined;
    elements.push({
      classes: classesOf(node, compound),
      data: dataOf(node, parent),
      group: "nodes",
    });
  }

  for (const edge of graph.edges) {
    if (!edgeIds.has(edge.id)) {
      continue;
    }
    elements.push({
      classes: `e-${edge.kind}${DASHED.includes(edge.kind) ? " dashed" : ""}`,
      data: {
        color: EDGE_COLOR[edge.kind],
        id: edge.id,
        kind: edge.kind,
        source: edge.source,
        target: edge.target,
      },
      group: "edges",
    });
  }

  return elements;
};

const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';

/** The one stylesheet all three views share. */
export const stylesheet = (): StylesheetJson => [
  {
    selector: "node",
    style: {
      "background-color": "data(color)",
      "background-opacity": 0.16,
      "border-color": "data(color)",
      "border-width": 1.4,
      color: "#e8ecf2",
      "font-family": MONO,
      "font-size": 12,
      height: "label",
      label: "data(label)",
      padding: "9px",
      shape: "round-rectangle",
      "text-halign": "center",
      "text-valign": "center",
      width: "label",
    },
  },
  {
    selector: "node.k-package",
    style: { "border-width": 1.8, "font-size": 14, padding: "12px" },
  },
  {
    // A fixed diamond with the label beneath it: a shape whose width follows
    // its label clips `WorkspaceNotFound` down to its middle third.
    selector: "node.k-error",
    style: {
      "background-opacity": 0.5,
      "font-size": 11,
      height: 24,
      padding: "0px",
      shape: "diamond",
      "text-margin-y": 5,
      "text-valign": "bottom",
      width: 24,
    },
  },
  {
    selector: "node.k-layer",
    style: { "border-width": 1.8, shape: "cut-rectangle" },
  },
  {
    selector: "node.external",
    style: { "border-style": "dashed", color: "#c3cad6" },
  },
  {
    // The label sits inside the box: ELK sizes a parent from its children and
    // its padding, and never from a label drawn outside the border.
    selector: "node.group",
    style: {
      "background-opacity": 0.05,
      "border-color": "#2f3a4b",
      "border-style": "dashed",
      "border-width": 1,
      color: "#9fb3c8",
      "font-size": 13,
      padding: "20px",
      "text-halign": "center",
      "text-margin-y": 15,
      "text-valign": "top",
    },
  },
  {
    selector: "edge",
    style: {
      "arrow-scale": 0.85,
      "curve-style": "bezier",
      "line-color": "data(color)",
      opacity: 0.75,
      "target-arrow-color": "data(color)",
      "target-arrow-shape": "triangle",
      width: 1.3,
    },
  },
  { selector: "edge.dashed", style: { "line-style": "dashed" } },
  { selector: "edge.e-declares", style: { opacity: 0.35 } },
  {
    selector: ".dim",
    style: { opacity: 0.12, "text-opacity": 0.12 },
  },
  // Focus hides rather than removes: the map keeps the positions it already
  // had, so isolating a node is the camera moving rather than a new picture.
  { selector: ".off", style: { display: "none" } },
  {
    selector: "node.match",
    style: { "border-color": "#fcd34d", "border-width": 3, color: "#fff7dc" },
  },
  {
    selector: "node.picked",
    style: {
      "background-opacity": 0.34,
      "border-color": "#f4f7fb",
      "border-width": 3,
      color: "#ffffff",
    },
  },
  {
    selector: "node.compare-b",
    style: { "border-color": "#c084fc", "border-width": 3 },
  },
];
