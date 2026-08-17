/**
 * The extractor against a two-package repository small enough to hold in the
 * head, so every count below is a number a reader can check against the
 * fixture source rather than a number that happened to come out.
 *
 * The repo smoke test at the bottom is lower bounds only. Its job is to fail
 * loudly when an Effect beta renames a brand — a map with no services on it
 * renders perfectly and says nothing.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { AtlasEdge, AtlasGraph, EdgeKind, NodeKind } from "../graph";
import { extractGraph } from "./index";

const FIXTURE = resolve(import.meta.dir, "../../test/fixture");
const REPO = resolve(import.meta.dir, "../../../..");

/** Long enough for a cold tsgo snapshot over every workspace on a loaded machine. */
const REPO_TIMEOUT = 120_000;

const fixture = await extractGraph({ root: FIXTURE });

const ids = (graph: AtlasGraph, kind: NodeKind) =>
  graph.nodes.filter((node) => node.kind === kind).map((node) => node.id);

const pairs = (edges: readonly AtlasEdge[], kind: EdgeKind) =>
  edges
    .filter((edge) => edge.kind === kind)
    .map((edge) => `${edge.source} -> ${edge.target}`)
    .sort();

const SERVICE = "svc:@fixture/pkg-a/TheService";
const ACTOR = "svc:@fixture/pkg-a/Actor";
const INFERRED = "svc:@fixture/pkg-a/Inferred";
const FS = "svc:ext/FileSystem";
const LAYER = "layer:pkg-a/src/service.ts#TheService.layer";
const EDITS = "layer:pkg-a/src/service.ts#TheService.editsLayer";
const SOME = "layer:pkg-b/src/layers.ts#someLayer";
const APP = "layer:pkg-b/src/layers.ts#appLayer";

describe("the fixture repository", () => {
  test("draws one node per thing and no node twice", () => {
    expect(ids(fixture, "package")).toEqual([
      "pkg:@fixture/pkg-a",
      "pkg:@fixture/pkg-b",
      "pkg:external",
    ]);
    expect(ids(fixture, "service")).toEqual([ACTOR, INFERRED, SERVICE, FS]);
    expect(ids(fixture, "error")).toEqual([
      "err:Fixture.Denied",
      "err:Fixture.NotFound",
    ]);
    expect(ids(fixture, "layer")).toEqual([EDITS, LAYER, APP, SOME]);
    expect(ids(fixture, "method")).toEqual([
      `method:${INFERRED}.run`,
      `method:${SERVICE}.read`,
      `method:${SERVICE}.transition`,
    ]);

    // Three files re-export the same symbols through barrels.
    const all = fixture.nodes.map((node) => node.id);
    expect(new Set(all).size).toBe(all.length);
  });

  test("reads both layer channels off the type", () => {
    expect(pairs(fixture.edges, "provides")).toEqual([
      `${EDITS} -> ${SERVICE}`,
      `${LAYER} -> ${SERVICE}`,
      `${APP} -> ${SERVICE}`,
      `${SOME} -> ${ACTOR}`,
    ]);
    expect(pairs(fixture.edges, "requires")).toEqual([`${LAYER} -> ${ACTOR}`]);
  });

  test("finds the second static layer, not just the one called layer", () => {
    const statics = fixture.nodes.filter(
      (node) => node.kind === "layer" && node.staticMember
    );
    expect(statics.map((node) => node.label).sort()).toEqual([
      "TheService.editsLayer",
      "TheService.layer",
    ]);
  });

  test("marks the factory as built per call", () => {
    const app = fixture.nodes.find((node) => node.id === APP);
    const some = fixture.nodes.find((node) => node.id === SOME);
    expect(app).toMatchObject({ kind: "layer", parameterized: true });
    expect(some).toMatchObject({ kind: "layer", parameterized: false });
  });

  test("marks the layer whose composition the type erased", () => {
    // `appLayer` is `Layer.provide(TheService.layer, …)`; `someLayer` is not.
    expect(fixture.nodes.find((node) => node.id === APP)).toMatchObject({
      composed: true,
    });
    expect(fixture.nodes.find((node) => node.id === SOME)).toMatchObject({
      composed: false,
    });
  });

  test("points a method at what the shape names, not at the return literal", async () => {
    const source = await Bun.file(`${FIXTURE}/pkg-a/src/service.ts`).text();
    const lines = source.split("\n");
    const declared =
      lines.findIndex((line) => line.includes("const run =")) + 1;
    const returned = lines.findIndex((line) => line.includes("return { run }"));

    const run = fixture.nodes.find(
      (node) => node.id === `method:${INFERRED}.run`
    );
    expect(run?.src?.line).toBe(declared);
    expect(run?.src?.line).not.toBe(returned + 1);
  });

  test("draws effectful members only, and counts the rest", () => {
    const service = fixture.nodes.find((node) => node.id === SERVICE);
    // label, read, transition — one of which is plain data.
    expect(service).toMatchObject({ kind: "service", memberCount: 3 });
    expect(
      fixture.nodes.some((node) => node.id === `method:${SERVICE}.label`)
    ).toBe(false);
  });

  test("puts requirements and errors on the method, where they live", () => {
    expect(pairs(fixture.edges, "method-requires")).toEqual([
      `method:${SERVICE}.read -> ${FS}`,
      `method:${SERVICE}.transition -> ${ACTOR}`,
    ]);
    expect(pairs(fixture.edges, "fails-with")).toEqual([
      `method:${SERVICE}.transition -> err:Fixture.Denied`,
      `method:${SERVICE}.transition -> err:Fixture.NotFound`,
    ]);
  });

  test("derives needs from both the layer and the method channel", () => {
    expect(pairs(fixture.edges, "needs")).toEqual([
      `${SERVICE} -> ${ACTOR}`,
      `${SERVICE} -> ${FS}`,
    ]);
  });

  test("keeps a vendored requirement as one external node", () => {
    const external = fixture.nodes.find((node) => node.id === FS);
    expect(external).toMatchObject({
      kind: "service",
      label: "FileSystem",
      origin: "external",
      pkg: "pkg:external",
    });
    // No src: it is not declared anywhere a reader of this repo can open.
    expect(external?.src).toBeUndefined();
  });

  test("ignores the test double that stubs a real service", () => {
    expect(
      fixture.nodes.some((node) => node.src?.file.includes(".test."))
    ).toBe(false);
    expect(
      fixture.edges.some(
        (edge) => edge.kind === "provides" && edge.source.includes(".test.")
      )
    ).toBe(false);
  });

  test("names one workspace dependency and gives every node a home", () => {
    expect(pairs(fixture.edges, "depends")).toEqual([
      "pkg:@fixture/pkg-b -> pkg:@fixture/pkg-a",
    ]);
    expect(fixture.stats.declares).toBe(12);
  });

  test("understands everything it saw", () => {
    expect(fixture.unresolved).toEqual([]);
  });
});

describe("the repository itself", () => {
  test(
    "maps without crashing, and loudly if a brand is renamed",
    async () => {
      const graph = await extractGraph({ root: REPO });

      // Both keys are Effect 4.0.0-beta internals. A beta bump that renames one
      // leaves a graph that renders perfectly and means nothing.
      expect(graph.stats.service).toBeGreaterThan(0);
      expect(graph.stats.error).toBeGreaterThan(0);

      expect(graph.stats.service).toBeGreaterThanOrEqual(40);
      expect(graph.stats.error).toBeGreaterThanOrEqual(70);
      expect(graph.stats.layer).toBeGreaterThanOrEqual(40);
      expect(graph.stats["method-requires"]).toBeGreaterThan(0);
      expect(graph.unresolved.length).toBeLessThan(40);

      const all = graph.nodes.map((node) => node.id);
      expect(new Set(all).size).toBe(all.length);
    },
    REPO_TIMEOUT
  );
});
