# atlas

A map of this repository's Effect services, read off the TypeScript checker: which service needs
which, which layer provides it, what each method requires and how it fails.

```bash
bun run atlas            # writes .atlas/graph.json and .atlas/atlas.html
bun run atlas --open     # and opens the page — macOS only, elsewhere it prints the path
bun run atlas --out docs # somewhere else
bun run atlas --help     # the flags
```

Six seconds. `atlas.html` is one self-contained file — open it from `file://`, no server and no
network. `.atlas/` is git-ignored. The run prints its own counts: files walked, exports classified,
one number per node and edge kind. Those are the numbers to quote, not the ones in this file.

Today's run: 20 workspace packages, 62 services, 78 layers, 160 methods, 82 errors.

## The three views

**Packages** — the 20 workspace packages and their `workspace:*` dependencies. Read off
`package.json`, not the checker.

**Services** — every service as a child of its package, with one edge kind: `needs`. `A needs B`
when a layer that provides `A` requires `B`, or when a method of `A` has `B` in its requirements.
That derived edge is what makes the view readable — 49 service nodes and 79 edges, where `provides`
and `requires` draw 306 edges through 78 layers. **show layers** answers "what builds this
one" — the layers that provide the selected service and what those require, five boxes for
`TaskRepo`. All 78 layers at once is 127 boxes and 306 edges on one canvas, so the switch is
disabled until something is selected, and the fifteen layers that merely require `TaskRepo` are a
list in the panel rather than a column on the canvas. **external** adds `FileSystem`, `PgClient`
and the rest, off by default because at rest they say only that everything touches the filesystem.

**Methods** — one service's effectful methods, what each requires (dashed) and the errors it raises
(red diamonds). Select a service first.

Everywhere: `/` focuses search, the arrow keys walk the hits and Enter picks one; `f` or
double-click isolates a node's closure — hiding the rest rather than redrawing, so the map keeps
the positions it had — Escape clears, and shift-click a second node while focused compares the
two. `fit`, `+` and `−` move the camera. The workspace menu hides packages; the edge
chips hide edge kinds. Click any node for its key, its `file:line`, its type and lists of what
provides it, needs it and fails inside it. Every entry in that panel is a link, and one pointing at
a node the current view does not draw switches to a view that does.

## How the graph is built

`typescript/unstable/async` opens the 19 workspace tsconfigs — never the root one, whose
`moduleResolution` types every workspace `any` — and the walk asks the real checker about every
exported symbol of every non-test source file.

A class whose declared type carries `~effect/Context/Service` is a service, and its key is the
string literal in `key`. A class carrying `~effect/Schema/Schema` with a `_tag` is an error. A
value typed `Layer` is a layer; so is a function returning one, which is how `storeLayer` and the
other 20 layer factories are found. Requirements come from the type arguments of `Layer<ROut, E, RIn>`
and `Effect<A, E, R>`, walked as unions — never by splitting the printed type on `|`.

A service returns its shape as one object literal, so every member's declaration is a single line
of `return { create, byId, … }`. Each entry is followed to the value it names, which is why
`TaskRepo.create` opens at the `Effect.fn` that defines it rather than at the return statement 400
lines below.

Nothing here is a regex over source text, and nothing is a heuristic on names. The one thing read
off syntax is whether a layer was built with `Layer.provide`, `Layer.provideMerge` or
`Layer.unwrap` — the panel says so, because that is exactly the case where the type has thrown the
answer away.

## What it does not see

- **Non-exported services and layers.** The walk is over module exports. `class Access` inside the
  gateway is invisible, and so is the build order `apps/gateway/src/layers.ts` spells out:
  `observabilityLayer`, `store`, `requestServicesLayer`, `apiLayer` and `routesLayer` are all
  module-level `const`s, so the graph shows `appLayer` and none of its five steps.
- **Composition.** `Layer.provide`, `Layer.provideMerge` and `Layer.unwrap` keep their type and
  lose their branch, so no edge says which layer was built from which. 21 layers are marked
  `composition not walked` in the panel; gateway's `appLayer` is one, and its `provides 8` is 8 of
  roughly 30.
- **`Context.Reference`.** `PidAlive`, `CurrentChatProgress` and the gateway's request-progress ref
  are references, not `Context.Service` classes, and get no node.
- **Per-request services.** `Principal` and `RequestAuth` are provided with `Effect.provideService`
  and have no layer. A service with no provider is not an error here.
- **Plain data members.** A member that is not effectful gets no method node; it only raises the
  service's member count.
- **28 references** the walk declined to name, listed in `graph.json` under `unresolved`. 26 are
  the group markers `HttpApiGroup` puts in a handler layer's requirements —
  `Service: Service<"atm", "artifacts">` and its twelve siblings — which name a shape the framework
  assembles rather than a service. The other 2 are the error channel of `RunControl.dispatch` and
  `.stop`, which the checker states as `unknown`.

The two brand strings are Effect 4 beta internals. A beta bump that renames them makes the map
empty, so `extract.test.ts` fails loudly on `services > 0 && errors > 0` instead.

## Layout

`src/graph.ts` is the model, and both halves depend only on it. `src/extract/*` is the checker
walk, `src/viewer/*` is the cytoscape page, `src/render.ts` bundles the viewer and splices it with
the graph into the one HTML file. The fixture under `test/fixture` is a two-package mini repo the
extractor runs over in `bun test`.

`src/index.ts` exports the model and `extractGraph`, so another workspace can `import
{ extractGraph } from "@workspace/atlas"` and hold the graph as a value. Nothing does today; the
CLI is the only caller.
