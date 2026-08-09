/**
 * What a test suite needs before it may write a row: a database of its own and
 * a workspace of its own.
 *
 * A separate entry point rather than part of the package's surface, because
 * nothing that boots should be able to reach it — `./root-env` overwrites
 * `DATABASE_URL`, and an application that imported it would quietly run against
 * the test database.
 */

export {
  ensureFixtureWorkspace,
  type FixtureWorkspace,
  FixtureWorkspaceMissing,
} from "./fixtures";
export { loadRootEnv, testDatabaseUrlOf, useTestDatabase } from "./root-env";
