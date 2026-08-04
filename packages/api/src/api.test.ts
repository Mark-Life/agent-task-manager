/**
 * What a contract package can be tested for, which is not much and is exactly
 * the two things that have gone wrong.
 *
 * **It derives.** `OpenApi.fromApi` walks every schema in the surface and
 * throws on a few things a typechecker is happy with — two components claiming
 * one name being the loudest. A test that only builds the document catches
 * that, and it is the failure mode of adding an entity.
 *
 * **Nothing is unguarded.** Every operation but the liveness probe carries a
 * security requirement, because that requirement is how the scope reaches both
 * the handler's types and an external consumer's tool description. An endpoint
 * declared without one compiles, serves, and is open.
 */

import { describe, expect, test } from "bun:test";
import { makeOpenApiSpec } from "./api";

/** The one operation with no credential: a probe that needed one would be useless to a supervisor. */
const UNGUARDED = new Set(["health.check"]);

/** HTTP methods a path object can hold, so the walk below ignores its other keys. */
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

const operations = () => {
  const spec = makeOpenApiSpec();
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const operation = item[method];
      return operation === undefined ? [] : [{ method, operation, path }];
    })
  );
};

describe("the contract", () => {
  test("derives an OpenAPI document", () => {
    const spec = makeOpenApiSpec();
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
  });

  test("guards every operation but the liveness probe", () => {
    const open = operations().filter(
      ({ operation }) =>
        !UNGUARDED.has(operation.operationId ?? "") &&
        (operation.security ?? []).length === 0
    );
    expect(open.map(({ method, path }) => `${method} ${path}`)).toEqual([]);
  });

  test("names a scheme that the document defines", () => {
    const spec = makeOpenApiSpec();
    const defined = new Set(Object.keys(spec.components.securitySchemes));
    const named = operations().flatMap(({ operation }) =>
      (operation.security ?? []).flatMap(Object.keys)
    );
    expect([...new Set(named)].filter((name) => !defined.has(name))).toEqual(
      []
    );
  });

  test("nests everything a task owns under its id", () => {
    const stray = Object.keys(makeOpenApiSpec().paths).filter(
      (path) =>
        path.startsWith("/tasks/") &&
        !(path === "/tasks/board" || path.startsWith("/tasks/{taskId}"))
    );
    expect(stray).toEqual([]);
  });

  // A conversation is not a card, so it is rooted beside the board rather than
  // under it — and everything it owns still nests under one id, so the thread
  // is proved once per request instead of once per read.
  test("nests everything a thread owns under its id", () => {
    const stray = Object.keys(makeOpenApiSpec().paths).filter(
      (path) => path.startsWith("/threads/") && !path.startsWith("/threads/{")
    );
    expect(stray).toEqual([]);
  });

  test("reaches a conversation without going through a task", () => {
    const paths = Object.keys(makeOpenApiSpec().paths);
    expect(paths).toContain("/threads");
    expect(paths).toContain("/threads/{threadId}/messages");
  });
});
