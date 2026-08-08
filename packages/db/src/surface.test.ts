/**
 * The package boundary, asserted rather than described.
 *
 * Row schemas, drizzle tables and the database handle are internal on purpose:
 * a caller holding any of them can write a row without the audit entry naming
 * who wrote it, which is the guarantee three kinds of writer sharing one
 * database rest on. Nothing but a comment stops someone re-exporting one during
 * a hurried afternoon, so the list below is the stop — adding to the public
 * surface fails here until it is a decision somebody wrote down.
 *
 * Type-only exports are absent because they are erased; a type cannot be used
 * to write a row.
 */

import { expect, test } from "bun:test";
import * as db from "./index";
import * as writePath from "./repositories/audit";
import * as rows from "./rows";
import * as schema from "./schema";

const SURFACE = [
  "AgentSessionEnded",
  "AgentSessionRepo",
  "AgentSessionUsageRepo",
  "ArtifactAlreadyPromoted",
  "ArtifactRepo",
  "AuditLogRepo",
  "Auth",
  "ChatMessageRepo",
  "ChatNotificationRepo",
  "ChatThreadRepo",
  "CommentRepo",
  "CurrentActor",
  "IllegalDeletion",
  "IllegalInitialStatus",
  "IllegalTransition",
  "InvalidInput",
  "MalformedRow",
  "NotFound",
  "PersistenceError",
  "ProjectEnvFileRepo",
  "ProjectRepo",
  "RunAlreadyLive",
  "RunCommandRepo",
  "RunEventRepo",
  "RunEventTooLarge",
  "RunNotLive",
  "RunNotStartable",
  "RunRepo",
  "THREAD_TITLE_MAX_CHARS",
  "TaskRepo",
  "WorkspaceRepo",
  "authOptions",
  "chatStoreLayer",
  "databaseConfig",
  "databaseLayer",
  "ensurePassword",
  "repositoriesLayer",
  "storeLayer",
  "withActor",
] as const;

const exported = Object.keys(db).sort();

test("the package exports exactly the surface it means to", () => {
  expect(exported).toEqual([...SURFACE]);
});

const leaked = (internal: object) => {
  const names = new Set(Object.keys(internal));
  return exported.filter((name) => names.has(name));
};

test("no drizzle table and no row schema reaches a caller", () => {
  expect(leaked(schema)).toEqual([]);
  expect(leaked(rows)).toEqual([]);
});

test("the drizzle handle and the pool behind it stay inside", () => {
  expect(exported).not.toContain("Database");
  expect(exported).not.toContain("DatabasePool");
});

/**
 * Naming the two handles is not enough, because the auth library was handed one
 * of them: anything exported that can run a statement is a way to write a row
 * with no actor and no audit entry, whatever it is called. So the test asks the
 * values what they can do rather than what they are named.
 */
const QUERY_METHODS = ["execute", "insert", "delete", "update", "query"];

const canQuery = (value: unknown) =>
  QUERY_METHODS.some(
    (method) => (value as Record<string, unknown>)[method] !== undefined
  );

test("nothing exported can run a statement", () => {
  const armed = Object.entries(db)
    .filter(([, value]) => canQuery(value))
    .map(([name]) => name);

  expect(armed).toEqual([]);
});

/**
 * The four error classes are the exception: a caller has to name them to handle
 * a failure, and holding one writes nothing.
 */
test("the shared write path is not something to build with", () => {
  expect(leaked(writePath)).toEqual([
    "InvalidInput",
    "MalformedRow",
    "NotFound",
    "PersistenceError",
  ]);
});
