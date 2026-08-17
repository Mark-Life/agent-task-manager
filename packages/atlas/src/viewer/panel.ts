/**
 * The detail panel: what one node is, where it is declared, and every node it
 * reaches — each entry selecting that node.
 *
 * The source path is plain selectable text rather than a link, because the
 * page is opened from `file://` and an editor URL that silently does nothing
 * is worse than a path somebody can copy.
 */

import type { AtlasGraph, AtlasNode, EdgeKind } from "../graph";
import { el } from "./dom";
import { KIND_COLOR } from "./elements";

/** How an outgoing edge of each kind reads in the panel. */
const OUT_LABEL: Readonly<Record<EdgeKind, string>> = {
  declares: "declares",
  depends: "depends on",
  "fails-with": "can fail with",
  "has-method": "methods",
  "method-requires": "requires",
  needs: "needs",
  provides: "provides",
  requires: "requires",
};

/** And how an incoming one reads. */
const IN_LABEL: Readonly<Record<EdgeKind, string>> = {
  declares: "declared in",
  depends: "depended on by",
  "fails-with": "raised by",
  "has-method": "method of",
  "method-requires": "required by methods",
  needs: "needed by",
  provides: "provided by",
  requires: "required by layers",
};

const ORDER: readonly EdgeKind[] = [
  "provides",
  "requires",
  "needs",
  "has-method",
  "method-requires",
  "fails-with",
  "depends",
  "declares",
];

const row = (label: string, value: string, wide = false) => {
  const wrap = el("div", wide ? "row wide" : "row");
  wrap.append(el("span", "row-key", label));
  wrap.append(el("span", "row-val mono", value));
  return wrap;
};

const badge = (text: string, tone?: string) => {
  const node = el("span", `badge${tone ? ` ${tone}` : ""}`, text);
  return node;
};

const sourceLine = (node: AtlasNode) => {
  if (node.src) {
    return `${node.src.file}:${node.src.line}`;
  }
  if (node.kind === "package" && node.dir) {
    return `${node.dir}/package.json`;
  }
  return "declared outside this repository";
};

const kindHeader = (node: AtlasNode) => {
  const head = el("div", "panel-head");
  const chip = el("span", "kind-chip", node.kind);
  chip.style.borderColor = KIND_COLOR[node.kind];
  chip.style.color = KIND_COLOR[node.kind];
  head.append(chip);
  head.append(el("h2", "panel-title mono", node.label));
  return head;
};

const facts = (node: AtlasNode) => {
  const wrap = el("div", "facts");
  if (node.kind === "service" && node.key) {
    wrap.append(row("key", node.key, true));
  }
  if (node.kind === "error" && node.tag) {
    wrap.append(row("_tag", node.tag));
  }
  if (node.kind === "package") {
    wrap.append(row("dir", node.dir || "node_modules"));
    wrap.append(row("group", node.group));
  }
  wrap.append(row("source", sourceLine(node), true));
  wrap.append(row("package", node.pkg));

  const flags = el("div", "flags");
  if (node.origin === "external") {
    flags.append(badge("external"));
  }
  if (node.kind === "service") {
    flags.append(badge(`${node.memberCount} members`));
    for (const tag of node.tags) {
      flags.append(badge(tag));
    }
  }
  if (node.kind === "layer") {
    flags.append(badge(node.staticMember ? "static member" : "module export"));
    if (node.parameterized) {
      flags.append(badge("built per call — must be built once", "warn"));
    }
    if (node.composed) {
      flags.append(
        badge("composition not walked — inner layers hidden", "warn")
      );
    }
  }
  if (flags.childElementCount > 0) {
    wrap.append(flags);
  }
  return wrap;
};

/**
 * The type, three lines of it, with the rest one click away.
 *
 * `TaskRepo` prints ten thousand characters. Shown in full it is a small
 * scroller inside the scrolling panel, cut mid-declaration, and 4% of it is
 * visible — so the box opens on demand, and the copy button takes the whole
 * string either way, which is what a structural type that size is for.
 */
const typeBox = (text: string) => {
  const wrap = el("div", "type-box");
  const pre = el("pre", "type mono clipped", text);
  const acts = el("div", "type-acts");
  const toggle = el("button", "chip", "show full type");
  toggle.type = "button";
  toggle.addEventListener("click", () => {
    const open = pre.classList.toggle("open");
    pre.classList.toggle("clipped", !open);
    toggle.textContent = open ? "collapse type" : "show full type";
  });
  const copy = el("button", "chip", "copy");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(text);
    copy.textContent = "copied";
  });
  acts.append(toggle, copy);
  wrap.append(pre, acts);
  return wrap;
};

const MAX_LISTED = 40;

const list = ({
  title,
  ids,
  graph,
  onSelect,
}: {
  readonly title: string;
  readonly ids: readonly string[];
  readonly graph: Map<string, AtlasNode>;
  readonly onSelect: (id: string) => void;
}) => {
  const section = el("section", "list");
  section.append(el("h3", "list-title", `${title} · ${ids.length}`));
  const items = el("div", "list-items");
  for (const id of ids.slice(0, MAX_LISTED)) {
    const node = graph.get(id);
    const button = el("button", "entry mono", node?.label ?? id);
    button.type = "button";
    button.style.borderLeftColor = node
      ? KIND_COLOR[node.kind]
      : KIND_COLOR.service;
    button.addEventListener("click", () => onSelect(id));
    items.append(button);
  }
  if (ids.length > MAX_LISTED) {
    items.append(el("span", "more", `+${ids.length - MAX_LISTED} more`));
  }
  section.append(items);
  return section;
};

const relations = ({
  graph,
  node,
}: {
  readonly graph: AtlasGraph;
  readonly node: AtlasNode;
}) => {
  const out = new Map<EdgeKind, string[]>();
  const inn = new Map<EdgeKind, string[]>();
  const push = (map: Map<EdgeKind, string[]>, kind: EdgeKind, id: string) => {
    const found = map.get(kind);
    if (found) {
      found.push(id);
    } else {
      map.set(kind, [id]);
    }
  };
  for (const edge of graph.edges) {
    if (edge.source === node.id) {
      push(out, edge.kind, edge.target);
    }
    if (edge.target === node.id) {
      push(inn, edge.kind, edge.source);
    }
  }
  return { inn, out };
};

/** Fills the panel for one node, or shows the empty hint. */
export const renderPanel = ({
  host,
  graph,
  node,
  onSelect,
  compare,
}: {
  readonly host: HTMLElement;
  readonly graph: AtlasGraph;
  readonly node: AtlasNode | undefined;
  readonly onSelect: (id: string) => void;
  /** Three counted lists, when a second node is being compared. */
  readonly compare?: {
    readonly a: string;
    readonly b: string;
    readonly both: readonly string[];
    readonly onlyA: readonly string[];
    readonly onlyB: readonly string[];
  };
}) => {
  host.replaceChildren();
  if (!node) {
    host.append(
      el(
        "p",
        "empty",
        "Click a node for its key, its source file and everything it reaches. Double-click to isolate it."
      )
    );
    return;
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  host.append(kindHeader(node));
  host.append(facts(node));

  if (node.typeText) {
    host.append(typeBox(node.typeText));
  }

  if (compare) {
    const a = byId.get(compare.a)?.label ?? compare.a;
    const b = byId.get(compare.b)?.label ?? compare.b;
    host.append(el("h3", "list-title", `compare ${a} vs ${b}`));
    host.append(
      list({ graph: byId, ids: compare.onlyA, onSelect, title: `only ${a}` })
    );
    host.append(
      list({ graph: byId, ids: compare.onlyB, onSelect, title: `only ${b}` })
    );
    host.append(
      list({ graph: byId, ids: compare.both, onSelect, title: "both" })
    );
    return;
  }

  const { out, inn } = relations({ graph, node });
  for (const kind of ORDER) {
    const outgoing = out.get(kind);
    if (outgoing && outgoing.length > 0) {
      host.append(
        list({ graph: byId, ids: outgoing, onSelect, title: OUT_LABEL[kind] })
      );
    }
    const incoming = inn.get(kind);
    if (incoming && incoming.length > 0) {
      host.append(
        list({ graph: byId, ids: incoming, onSelect, title: IN_LABEL[kind] })
      );
    }
  }
};
