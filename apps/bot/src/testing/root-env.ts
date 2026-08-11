/**
 * The test preload for this package: the repository's `.env` in the
 * environment, and `DATABASE_URL` pointed at the test database.
 *
 * One line of its own rather than a copy of the logic. There were four copies,
 * and four copies of "which database do the tests write to" is four answers.
 * `@workspace/db/testing/root-env` is the answer; read it for why this is a
 * preload and not something a test file calls.
 */

export { loadRootEnv } from "@workspace/db/testing/root-env";
