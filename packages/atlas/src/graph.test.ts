import { describe, expect, test } from "bun:test";
import { createGraphBuilder, edgeId, nodeId } from "./graph";

describe("nodeId", () => {
  test("prefers the identity that survives a file move", () => {
    expect(nodeId.serviceByKey("@workspace/db/WorkspaceRepo")).toBe(
      "svc:@workspace/db/WorkspaceRepo"
    );
    expect(
      nodeId.serviceByDeclaration({
        file: "apps/gateway/src/auth/access.ts",
        name: "Access",
      })
    ).toBe("svc:apps/gateway/src/auth/access.ts#Access");
    expect(nodeId.externalService("FileSystem")).toBe("svc:ext/FileSystem");
  });

  test("names a layer by its declaration, statics included", () => {
    expect(
      nodeId.layer({ file: "packages/db/src/store.ts", name: "storeLayer" })
    ).toBe("layer:packages/db/src/store.ts#storeLayer");
    expect(
      nodeId.layer({
        file: "packages/sandbox/src/history.ts",
        name: "ScopeHistory.editsLayer",
      })
    ).toBe("layer:packages/sandbox/src/history.ts#ScopeHistory.editsLayer");
  });

  test("hangs a method off the service that owns it", () => {
    expect(
      nodeId.method({
        name: "transition",
        service: nodeId.serviceByKey("@workspace/db/TaskRepo"),
      })
    ).toBe("method:svc:@workspace/db/TaskRepo.transition");
  });

  test("names an error by its tag, falling back to the file", () => {
    expect(nodeId.errorByTag("Sandbox.DaemonUnreachable")).toBe(
      "err:Sandbox.DaemonUnreachable"
    );
    expect(
      nodeId.errorByDeclaration({
        file: "packages/sandbox/src/errors.ts",
        name: "DaemonUnreachable",
      })
    ).toBe("err:packages/sandbox/src/errors.ts#DaemonUnreachable");
  });
});

test("an edge is its three parts and nothing else", () => {
  expect(edgeId({ kind: "needs", source: "svc:a", target: "svc:b" })).toBe(
    "needs:svc:a->svc:b"
  );
});

const service = (id: string) =>
  ({
    id,
    kind: "service",
    label: id,
    memberCount: 0,
    origin: "workspace",
    pkg: "pkg:@workspace/db",
    tags: [],
  }) as const;

describe("GraphBuilder", () => {
  test("keeps the first description of a node, not the last", () => {
    const builder = createGraphBuilder();
    const first = builder.addNode({ ...service("svc:a"), memberCount: 7 });
    const second = builder.addNode({ ...service("svc:a"), memberCount: 0 });

    expect(second).toBe(first);
    expect(builder.nodes()).toHaveLength(1);
    expect(builder.getNode("svc:a")).toMatchObject({ memberCount: 7 });
  });

  test("one triple is one edge, however often it is stated", () => {
    const builder = createGraphBuilder();
    const edge = { kind: "needs", source: "svc:a", target: "svc:b" } as const;

    expect(builder.addEdge(edge)).toBe(builder.addEdge(edge));
    expect(builder.edges()).toHaveLength(1);
  });

  test("sorts by id and counts every kind it holds", () => {
    const builder = createGraphBuilder();
    builder.addNode(service("svc:b"));
    builder.addNode(service("svc:a"));
    builder.addEdge({ kind: "needs", source: "svc:a", target: "svc:b" });
    builder.addUnresolved({
      detail: 'Service: Service<"atm", "artifacts">',
      reason: "opaque-requirement",
      where: "layer:x#y",
    });

    const graph = builder.build({
      generatedAt: "2026-01-01T00:00:00.000Z",
      root: "/repo",
      totals: { exports: 3, files: 2, ms: 1 },
    });

    expect(graph.nodes.map((node) => node.id)).toEqual(["svc:a", "svc:b"]);
    expect(graph.stats.service).toBe(2);
    expect(graph.stats.needs).toBe(1);
    expect(graph.stats.layer).toBe(0);
    expect(graph.stats.files).toBe(2);
    expect(graph.unresolved).toHaveLength(1);
  });
});
