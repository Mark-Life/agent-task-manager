/**
 * Substring search over label, id, key and file path, and the list of hits.
 *
 * The list exists because the counts lie on their own: three nodes are called
 * `appLayer` and the bar can only say `3 matches`, so picking the first one is
 * picking whichever the walk happened to reach first. Every hit is shown with
 * its package and its file, and a hit the current view does not draw says so
 * rather than selecting into an unchanged picture.
 */

import type { AtlasGraph, AtlasNode } from "../graph";
import { el, need } from "./dom";
import { KIND_COLOR } from "./elements";

const haystack = (node: AtlasNode) => {
  const parts = [node.id, node.label];
  if (node.src) {
    parts.push(node.src.file);
  }
  if (node.kind === "service" && node.key) {
    parts.push(node.key);
  }
  if (node.kind === "error" && node.tag) {
    parts.push(node.tag);
  }
  return parts.join(" ").toLowerCase();
};

/**
 * Nodes whose label, id, key or file path contains the query, best first: a
 * label that starts with the query, then by label, then by package — so two
 * `appLayer`s always come back in the same order rather than in walk order.
 */
export const searchNodes = ({
  graph,
  query,
}: {
  readonly graph: AtlasGraph;
  readonly query: string;
}): readonly AtlasNode[] => {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }
  const hits = graph.nodes.filter((node) => haystack(node).includes(needle));
  const starts = (node: AtlasNode) =>
    node.label.toLowerCase().startsWith(needle) ? 0 : 1;
  return [...hits].sort(
    (a, b) =>
      starts(a) - starts(b) ||
      a.label.localeCompare(b.label) ||
      a.pkg.localeCompare(b.pkg)
  );
};

/** How many hits the list shows before it says how many more there are. */
const MAX_ROWS = 12;

const whereOf = (node: AtlasNode) =>
  node.src ? `${node.src.file}:${node.src.line}` : node.id;

/** The results list under the search box. */
export interface SearchList {
  /** The row the arrow keys are on, if the list is open. */
  readonly current: () => AtlasNode | undefined;
  readonly hide: () => void;
  readonly move: (delta: number) => void;
  /** Redraws the list. An empty list of hits hides it. */
  readonly show: (options: {
    readonly drawn: (id: string) => boolean;
    readonly hits: readonly AtlasNode[];
  }) => void;
}

/** Builds the list and returns the handful of things the page does to it. */
export const mountSearchList = ({
  onPick,
}: {
  readonly onPick: (node: AtlasNode) => void;
}): SearchList => {
  const host = need("search-list");
  let shown: readonly AtlasNode[] = [];
  let index = 0;

  const paint = (drawn: (id: string) => boolean) => {
    host.replaceChildren();
    shown.forEach((node, position) => {
      const row = el("button", `hit${position === index ? " on" : ""}`);
      row.type = "button";
      const top = el("div", "hit-top");
      const kind = el("span", "hit-kind mono", node.kind);
      kind.style.color = KIND_COLOR[node.kind];
      top.append(kind, el("span", "hit-label", node.label));
      if (!drawn(node.id)) {
        top.append(el("span", "hit-off", "not in this view"));
      }
      row.append(top, el("div", "hit-where", `${node.pkg} · ${whereOf(node)}`));
      row.addEventListener("mousedown", (event) => {
        // The input still has focus, and losing it before the click lands
        // closes the list out from under the pointer.
        event.preventDefault();
        onPick(node);
      });
      host.append(row);
    });
    host.hidden = shown.length === 0;
  };

  return {
    current: () => (host.hidden ? undefined : shown[index]),
    hide: () => {
      host.hidden = true;
    },
    move: (delta) => {
      if (shown.length === 0) {
        return;
      }
      index = (index + delta + shown.length) % shown.length;
      for (const [position, row] of [...host.children].entries()) {
        row.classList.toggle("on", position === index);
      }
      host.children[index]?.scrollIntoView({ block: "nearest" });
    },
    show: ({ hits, drawn }) => {
      const next = hits.slice(0, MAX_ROWS);
      // A new query starts at the top; a redraw of the same hits keeps the row
      // the arrow keys are on.
      const same =
        next.length === shown.length &&
        next.every((node, position) => node.id === shown[position]?.id);
      shown = next;
      index = same && shown.length > 0 ? Math.min(index, shown.length - 1) : 0;
      paint(drawn);
      if (hits.length > next.length) {
        host.append(
          el("div", "more", `+${hits.length - next.length} more — keep typing`)
        );
      }
    },
  };
};
