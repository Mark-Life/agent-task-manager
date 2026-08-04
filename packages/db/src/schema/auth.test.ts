/**
 * The one thing we add to a table the auth library owns.
 *
 * Its `member` table indexes the organization and the user separately and
 * declares no composite unique, so one user can hold two membership rows in the
 * same workspace and every authorization query would be reading whichever came
 * back first. The index that closes that is added after the schema is
 * generated, by `scripts/auth-schema-index.ts`, and a regeneration that skipped
 * the script would silently reopen the hole — which is what this test is for.
 */

import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { member } from "./auth";

const indexes = getTableConfig(member).indexes.map((index) => index.config);

test("member is unique on (organization, user)", () => {
  const composite = indexes.find(
    (config) => config.name === "member_org_user_uq"
  );

  expect({
    // An indexed column carries its name; an indexed expression does not, and
    // this index is over two plain columns.
    columns: composite?.columns.map((column) =>
      "name" in column ? column.name : null
    ),
    unique: composite?.unique,
  }).toEqual({ columns: ["organization_id", "user_id"], unique: true });
});
