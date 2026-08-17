/**
 * The top bar: view switch, edge-kind chips, workspace menu, legend.
 *
 * Every control is built once and handed a callback; the state itself lives in
 * `main.ts`, and `sync` is what puts the bar back in step with it after a
 * change made anywhere else — a keyboard shortcut, a click on the canvas.
 */

import {
  type AtlasGraph,
  EDGE_KINDS,
  type EdgeKind,
  EXTERNAL_PACKAGE_ID,
} from "../graph";
import { el, need } from "./dom";
import { EDGE_COLOR, KIND_COLOR, KIND_LABEL } from "./elements";
import {
  availableEdgeKinds,
  layersAvailable,
  VIEWS,
  type ViewName,
  type ViewState,
} from "./views";

const dot = (color: string) => {
  const node = el("span", "dot");
  node.style.background = color;
  return node;
};

/** Everything the bar can change, in one callback shape. */
export interface ControlHandlers {
  readonly onEdgeKind: (kind: EdgeKind) => void;
  readonly onPackages: (packages: ReadonlySet<string>) => void;
  readonly onSearch: (query: string) => void;
  readonly onSearchEnter: () => void;
  /** Arrow keys walking the results list: -1 up, 1 down. */
  readonly onSearchMove: (delta: number) => void;
  readonly onShowExternal: (on: boolean) => void;
  readonly onShowLayers: (on: boolean) => void;
  readonly onUnfocus: () => void;
  readonly onView: (view: ViewName) => void;
  readonly onZoom: (step: "fit" | "in" | "out") => void;
}

const mountViews = (handlers: ControlHandlers) => {
  const host = need("views");
  const buttons = new Map<ViewName, HTMLButtonElement>();
  for (const view of VIEWS) {
    const button = el("button", "seg-btn", view);
    button.type = "button";
    button.addEventListener("click", () => handlers.onView(view));
    buttons.set(view, button);
    host.append(button);
  }
  return buttons;
};

const mountEdges = (handlers: ControlHandlers) => {
  const host = need("edges");
  const chips = new Map<EdgeKind, HTMLButtonElement>();
  for (const kind of EDGE_KINDS) {
    const chip = el("button", "chip");
    chip.type = "button";
    chip.append(dot(EDGE_COLOR[kind]));
    chip.append(el("span", undefined, kind));
    chip.addEventListener("click", () => handlers.onEdgeKind(kind));
    chips.set(kind, chip);
    host.append(chip);
  }
  return chips;
};

const mountLegend = () => {
  const host = need("legend");
  for (const [kind, color] of Object.entries(KIND_COLOR)) {
    const chip = el("span", "chip static");
    chip.append(dot(color));
    chip.append(
      el("span", undefined, KIND_LABEL[kind as keyof typeof KIND_LABEL])
    );
    host.append(chip);
  }
};

const mountPackages = ({
  graph,
  handlers,
  initial,
}: {
  readonly graph: AtlasGraph;
  readonly handlers: ControlHandlers;
  readonly initial: ReadonlySet<string>;
}) => {
  const button = need<HTMLButtonElement>("pkg-btn");
  const menu = need("pkg-menu");
  const chosen = new Set(initial);
  // The external bucket is not a workspace. It is filtered by the `external`
  // switch instead, so it stays selected here and out of the menu and the count.
  const packages = graph.nodes.filter(
    (node) => node.kind === "package" && node.id !== EXTERNAL_PACKAGE_ID
  );

  const emit = () =>
    handlers.onPackages(new Set(chosen).add(EXTERNAL_PACKAGE_ID));

  const actions = el("div", "menu-actions");
  for (const [label, pick] of [
    ["all", true],
    ["none", false],
  ] as const) {
    const action = el("button", "link", label);
    action.type = "button";
    action.addEventListener("click", () => {
      chosen.clear();
      if (pick) {
        for (const node of packages) {
          chosen.add(node.id);
        }
      }
      for (const box of menu.querySelectorAll("input")) {
        box.checked = pick;
      }
      emit();
    });
    actions.append(action);
  }
  menu.append(actions);

  for (const node of packages) {
    const label = el("label", "menu-item");
    const box = el("input");
    box.type = "checkbox";
    box.checked = chosen.has(node.id);
    box.addEventListener("change", () => {
      if (box.checked) {
        chosen.add(node.id);
      } else {
        chosen.delete(node.id);
      }
      emit();
    });
    label.append(box);
    label.append(el("span", "mono", node.label));
    menu.append(label);
  }

  button.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
  });
  document.addEventListener("click", (event) => {
    const { target } = event;
    const inside =
      target instanceof Node &&
      (menu.contains(target) || button.contains(target));
    if (!(inside || menu.hidden)) {
      menu.hidden = true;
    }
  });

  return { button, count: packages.length };
};

const ARROW: Readonly<Record<string, number | undefined>> = {
  ArrowDown: 1,
  ArrowUp: -1,
};

const ZOOM = [
  ["zoom-fit", "fit"],
  ["zoom-in", "in"],
  ["zoom-out", "out"],
] as const;

/** Builds the bar and returns the one function that re-syncs it with state. */
export const mountControls = ({
  graph,
  state,
  handlers,
}: {
  readonly graph: AtlasGraph;
  readonly state: ViewState;
  readonly handlers: ControlHandlers;
}) => {
  const views = mountViews(handlers);
  const chips = mountEdges(handlers);
  mountLegend();
  const packages = mountPackages({
    graph,
    handlers,
    initial: state.packages,
  });

  const search = need<HTMLInputElement>("search");
  search.addEventListener("input", () => handlers.onSearch(search.value));
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      handlers.onSearchEnter();
      return;
    }
    const delta = ARROW[event.key];
    if (delta) {
      event.preventDefault();
      handlers.onSearchMove(delta);
    }
  });

  for (const [id, step] of ZOOM) {
    need(id).addEventListener("click", () => handlers.onZoom(step));
  }

  const layers = need<HTMLInputElement>("layers");
  layers.addEventListener("change", () =>
    handlers.onShowLayers(layers.checked)
  );

  const external = need<HTMLInputElement>("external");
  external.addEventListener("change", () =>
    handlers.onShowExternal(external.checked)
  );

  const focusChip = need("focus-chip");
  focusChip.addEventListener("click", () => handlers.onUnfocus());

  const layersWrap = need("layers-wrap");
  const externalWrap = need("external-wrap");
  const stats = need("stats");
  const counts = need("search-count");

  return {
    /** Puts every control back in step with `next`. */
    sync: (
      next: ViewState,
      extra: { readonly matches: number; readonly status: string }
    ) => {
      for (const [view, button] of views) {
        button.classList.toggle("on", view === next.view);
      }
      const available = new Set(availableEdgeKinds(next));
      for (const [kind, chip] of chips) {
        chip.classList.toggle("on", next.edgeKinds.has(kind));
        chip.classList.toggle("na", !available.has(kind));
      }
      layersWrap.hidden = next.view !== "services";
      const canLayer = layersAvailable({ graph, state: next });
      layers.checked = next.showLayers;
      layers.disabled = !canLayer;
      layersWrap.classList.toggle("off", !canLayer);
      layersWrap.title = canLayer
        ? "layers that build the selected service"
        : "select a service first — every layer at once is unreadable";
      externalWrap.hidden = next.view !== "services";
      external.checked = next.showExternal;
      focusChip.hidden = next.focus === null;
      focusChip.textContent = next.focus
        ? `focus ${graph.nodes.find((n) => n.id === next.focus)?.label ?? ""} — clear`
        : "";
      const workspaces = [...next.packages].filter(
        (id) => id !== EXTERNAL_PACKAGE_ID
      ).length;
      packages.button.textContent = `workspaces ${workspaces}/${packages.count}`;
      counts.textContent =
        search.value.trim().length > 0 ? `${extra.matches} matches` : "";
      stats.textContent = extra.status;
    },
  };
};
