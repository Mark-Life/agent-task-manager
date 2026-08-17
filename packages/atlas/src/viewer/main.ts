/**
 * Viewer entry point. Bundled by `render.ts` and inlined into `atlas.html`,
 * so it reads the graph off `window.__ATLAS__` rather than fetching it.
 *
 * One value drives the page: `state`. Every control writes a patch, `render`
 * projects the graph through it, replaces the elements and runs the layout.
 * Nothing else mutates the canvas.
 */

import cytoscape from "cytoscape";
import elk from "cytoscape-elk";
import type { AtlasGraph, AtlasNode } from "../graph";
import { mountControls } from "./controls";
import { mountShell, need } from "./dom";
import { stylesheet, toElements } from "./elements";
import { renderPanel } from "./panel";
import { mountSearchList, searchNodes } from "./search";
import {
  compareClosures,
  initialState,
  type Projection,
  project,
  type ViewName,
  type ViewState,
} from "./views";

declare global {
  interface Window {
    __ATLAS__: AtlasGraph;
  }
}

const LAYOUT = {
  animate: false,
  elk: {
    algorithm: "layered",
    "elk.direction": "RIGHT",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.layered.spacing.nodeNodeBetweenLayers": 60,
    "elk.padding": "[top=40,left=20,bottom=20,right=20]",
    "elk.spacing.componentComponent": 44,
    "elk.spacing.nodeNode": 34,
  },
  // The camera is moved by hand once the solve has finished, not by the layout:
  // `fit` here runs against the box the elements had before ELK placed them.
  fit: false,
  name: "elk",
  nodeDimensionsIncludeLabels: true,
  padding: 26,
} as unknown as cytoscape.LayoutOptions;

/**
 * The placement used when ELK does not answer.
 *
 * ELK's bundled solver returns nothing at all for some graphs — no result, no
 * error, no `layoutstop` — and a projection left unplaced is every box stacked
 * on the origin. Cytoscape's own layout is synchronous and always answers, so
 * the viewer stops waiting after {@link SOLVE_BUDGET_MS} and uses it instead.
 */
const PLACE = {
  animate: false,
  fit: false,
  idealEdgeLength: 120,
  name: "cose",
  nodeDimensionsIncludeLabels: true,
  nodeRepulsion: 900_000,
  numIter: 900,
} as cytoscape.LayoutOptions;

/** How long ELK gets before the viewer stops waiting on it. */
const SOLVE_BUDGET_MS = 1500;

/**
 * The states to try, in order, when a node has to be shown: stay where we are
 * if the node is already drawn, then the cheapest toggle, then another view.
 */
const REACHES: readonly Partial<ViewState>[] = [
  {},
  { showExternal: true },
  { showLayers: true },
  { showExternal: true, showLayers: true },
  { view: "services" },
  { showExternal: true, view: "services" },
  { showLayers: true, view: "services" },
  { showExternal: true, showLayers: true, view: "services" },
  { view: "methods" },
  { view: "packages" },
];

/** Margin, in pixels, around a graph the viewer has just fitted. */
const FIT_PADDING = 40;

const ZOOM_STEP = 1.3;

/** Registers the layout extension, builds the instance, wires the controls. */
export const start = (graph: AtlasGraph) => {
  mountShell();
  cytoscape.use(elk);

  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const panelHost = need("panel");
  const hintHost = need("hint");
  const searchInput = need<HTMLInputElement>("search");

  let state: ViewState = initialState(graph);
  let matches: readonly AtlasNode[] = [];
  let listOpen = false;
  let drawn = "";
  let framed = "";
  let solving = false;
  let queued: Projection | null = null;

  const cy = cytoscape({
    container: need("cy"),
    maxZoom: 2.5,
    minZoom: 0.05,
    style: stylesheet(),
    wheelSensitivity: 0.25,
  });

  // For a browser check driving the page from outside: cytoscape draws to a
  // canvas and leaves no DOM per node, so reading back what was placed where
  // has to go through the instance.
  Object.assign(window, { __ATLAS_CY__: cy, __ATLAS_STATE__: () => state });

  const status = (shown: number, edges: number) =>
    `${shown}/${graph.nodes.length} nodes · ${edges} edges`;

  const paintPanel = () => {
    const node = state.selected ? byId.get(state.selected) : undefined;
    const compare =
      state.focus && state.compare
        ? {
            ...compareClosures({
              a: state.focus,
              b: state.compare,
              graph,
              state,
            }),
            a: state.focus,
            b: state.compare,
          }
        : undefined;
    renderPanel({
      compare,
      graph,
      host: panelHost,
      node,
      onSelect: (id) => reveal(id),
    });
  };

  const paintMarks = () => {
    cy.nodes().removeClass("match picked compare-b");
    for (const hit of matches) {
      cy.getElementById(hit.id).addClass("match");
    }
    if (state.selected) {
      cy.getElementById(state.selected).addClass("picked");
    }
    if (state.compare) {
      cy.getElementById(state.compare).addClass("compare-b");
    }
  };

  /** Hides everything focus leaves out. Nothing is removed, so nothing moves. */
  const mask = (projection: Projection) => {
    cy.batch(() => {
      for (const element of cy.elements()) {
        const shown =
          projection.shownNodeIds.has(element.id()) ||
          projection.shownEdgeIds.has(element.id());
        element.toggleClass("off", !shown);
      }
    });
  };

  /** Frames what is showing and puts the highlights back on it. */
  const settle = (marks: boolean) => {
    const shown = cy.elements().not(".off");
    if (shown.length > 0) {
      cy.fit(shown, FIT_PADDING);
    }
    if (marks) {
      paintMarks();
    }
  };

  /**
   * Swaps the elements, places them, and asks ELK for a better arrangement.
   *
   * One projection at a time: removing the elements ELK is placing loses its
   * `layoutstop`, and then nothing fits the camera again. A projection that
   * arrives mid-solve waits its turn instead.
   */
  const draw = (projection: Projection) => {
    solving = true;
    cy.startBatch();
    cy.elements().remove();
    cy.add(
      toElements({
        compound: projection.compound,
        edgeIds: projection.edgeIds,
        graph,
        nodeIds: projection.nodeIds,
      })
    );
    cy.endBatch();
    mask(projection);
    if (cy.nodes().length === 0) {
      solving = false;
      return;
    }

    let landed = false;
    const done = (place: boolean) => {
      if (landed) {
        return;
      }
      landed = true;
      if (place) {
        cy.layout(PLACE).run();
      }
      solving = false;
      const next = queued;
      queued = null;
      if (next) {
        draw(next);
        return;
      }
      settle(true);
    };
    const layout = cy.layout(LAYOUT);
    layout.one("layoutstop", () => done(false));
    layout.run();
    setTimeout(() => done(true), SOLVE_BUDGET_MS);
  };

  let projected: ReadonlySet<string> = new Set();

  const render = () => {
    const projection = project({ graph, state });
    projected = projection.shownNodeIds;
    const ids = [...projection.nodeIds].sort().join(",");
    const links = [...projection.edgeIds].sort().join(",");
    const signature = `${projection.compound}|${ids}|${links}`;
    const slice = [...projection.shownNodeIds].sort().join(",");
    if (signature !== drawn) {
      drawn = signature;
      framed = slice;
      if (solving) {
        queued = projection;
      } else {
        draw(projection);
      }
    } else if (slice !== framed) {
      // Same elements, a different slice of them: hide and re-frame, never
      // re-solve. Focus is the only control that lands here.
      framed = slice;
      mask(projection);
      settle(false);
    }
    paintMarks();
    hintHost.hidden = projection.hint === null;
    hintHost.textContent = projection.hint ?? "";
    controls.sync(state, {
      matches: matches.length,
      status: status(
        projection.shownNodeIds.size,
        projection.shownEdgeIds.size
      ),
    });
    if (listOpen) {
      searchList.show({ drawn: (id) => projected.has(id), hits: matches });
    } else {
      searchList.hide();
    }
    paintPanel();
  };

  const patch = (next: Partial<ViewState>) => {
    state = { ...state, ...next };
    render();
  };

  /**
   * Selects a node and, when the current view does not draw it, moves to a
   * view that does. Every entry in the panel and every row of the search list
   * points at a node id, and selecting one the canvas cannot show leaves the
   * panel and the picture disagreeing about what is selected.
   */
  const reveal = (id: string) => {
    const packages = new Set(state.packages);
    const node = byId.get(id);
    if (node) {
      packages.add(node.pkg);
    }
    const base = { packages, selected: id };
    for (const focus of [state.focus, null]) {
      for (const candidate of REACHES) {
        const next = { ...state, ...base, ...candidate, focus };
        if (project({ graph, state: next }).nodeIds.has(id)) {
          patch({ ...base, ...candidate, focus });
          return;
        }
      }
    }
    patch(base);
  };

  const searchList = mountSearchList({
    onPick: (node) => {
      searchInput.blur();
      listOpen = false;
      reveal(node.id);
    },
  });

  const controls = mountControls({
    graph,
    handlers: {
      onEdgeKind: (kind) => {
        const kinds = new Set(state.edgeKinds);
        if (kinds.has(kind)) {
          kinds.delete(kind);
        } else {
          kinds.add(kind);
        }
        patch({ edgeKinds: kinds });
      },
      onPackages: (packages) => patch({ packages }),
      onSearch: (query) => {
        matches = searchNodes({ graph, query });
        listOpen = matches.length > 0;
        render();
      },
      onSearchEnter: () => {
        const pick = searchList.current() ?? matches[0];
        if (pick) {
          // Leave the field, so `f` reaches the canvas rather than the query.
          searchInput.blur();
          listOpen = false;
          reveal(pick.id);
        }
      },
      onSearchMove: (delta) => searchList.move(delta),
      onShowExternal: (showExternal) => patch({ showExternal }),
      onShowLayers: (showLayers) => patch({ showLayers }),
      onUnfocus: () => patch({ compare: null, focus: null }),
      onView: (view: ViewName) => patch({ compare: null, focus: null, view }),
      onZoom: (step) => {
        if (step === "fit") {
          cy.fit(cy.elements(), FIT_PADDING);
          return;
        }
        cy.zoom({
          level: cy.zoom() * (step === "in" ? ZOOM_STEP : 1 / ZOOM_STEP),
          renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
        });
      },
    },
    state,
  });

  const heldShift = (event: cytoscape.EventObject) =>
    Boolean((event.originalEvent as MouseEvent | undefined)?.shiftKey);

  cy.on("tap", "node", (event) => {
    const id = String(event.target.id());
    if (heldShift(event) && state.focus) {
      patch({ compare: id, selected: id });
      return;
    }
    patch({ selected: id });
  });

  cy.on("dbltap", "node", (event) => {
    // Shift is the compare gesture, and compare must never move the focus it
    // is comparing against.
    if (heldShift(event)) {
      return;
    }
    const id = String(event.target.id());
    patch({ focus: id, selected: id });
  });

  cy.on("tap", (event) => {
    if (event.target === cy) {
      listOpen = false;
      patch({ compare: null, selected: null });
    }
  });

  cy.on("mouseover", "node", (event) => {
    const near = event.target.closedNeighborhood().union(event.target.parent());
    cy.elements().difference(near).addClass("dim");
  });
  cy.on("mouseout", "node", () => {
    cy.elements().removeClass("dim");
  });
  // A pointer that leaves the canvas over a node never fires `mouseout`, and
  // the map stays dimmed until the next click.
  need("cy").addEventListener("mouseleave", () => {
    cy.elements().removeClass("dim");
  });

  document.addEventListener("keydown", (event) => {
    // A held key repeats, and `f` repeating would drag focus along behind
    // every later selection.
    if (event.repeat) {
      return;
    }
    const typing = document.activeElement === searchInput;
    if (event.key === "/" && !typing) {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }
    if (event.key === "Escape") {
      if (typing) {
        searchInput.value = "";
        searchInput.blur();
        matches = [];
        listOpen = false;
        render();
        return;
      }
      listOpen = false;
      patch({ compare: null, focus: null, selected: null });
      return;
    }
    if (event.key === "f" && !typing && state.selected) {
      patch({ focus: state.selected });
    }
  });

  render();
};

start(window.__ATLAS__);
