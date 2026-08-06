/**
 * The `apikey` table against the plugin that owns it.
 *
 * `./auth` is generated, and the generator could not be run in the environment
 * this table was first written in — so the table was written by hand to match
 * what the plugin declares. That is fine exactly once. What makes it stay fine
 * is this: the plugin carries its own field list at runtime, so "the column
 * definition still matches the library" is a check rather than a memory, and an
 * upgrade that adds, drops or retypes a field fails here instead of failing as
 * a query against a column that is not there.
 *
 * It reads the plugin off the built options rather than constructing a fresh
 * one, so the two rate-limit defaults — which the plugin bakes into the schema
 * from its configuration — are compared against the configuration this
 * deployment actually runs.
 */

import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { options } from "../auth/options";
import { apikey } from "./auth";

/** The auth library spells a field `refillAmount`; the column is `refill_amount`. */
const snakeCase = (name: string) =>
  name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** The plugin's own declaration of what it stores, as configured here. */
const declaredFields = () => {
  const plugin = options.plugins.find(
    (candidate) => candidate.id === "api-key"
  );
  const fields = plugin?.schema?.apikey?.fields;
  if (fields === undefined) {
    throw new Error("the api-key plugin is not configured on the auth options");
  }
  return fields;
};

const columns = new Map(
  getTableConfig(apikey).columns.map((column) => [column.name, column])
);

test("every field the plugin declares has a column", () => {
  const missing = Object.keys(declaredFields())
    .map(snakeCase)
    .filter((name) => !columns.has(name));

  expect(missing).toEqual([]);
});

test("the table holds nothing the plugin does not declare", () => {
  // `id` is the primary key the generator writes for every model rather than a
  // declared field, so it is the one column with no entry in the field list.
  const declared = new Set([
    "id",
    ...Object.keys(declaredFields()).map(snakeCase),
  ]);
  const extra = [...columns.keys()].filter((name) => !declared.has(name));

  expect(extra).toEqual([]);
});

test("a field the plugin requires is NOT NULL", () => {
  const required = Object.entries(declaredFields())
    .filter(([, field]) => field.required === true)
    .map(([name]) => snakeCase(name));

  expect(
    required.filter((name) => columns.get(name)?.notNull !== true)
  ).toEqual([]);
});

test("the rate limit this deployment configured is the column default", () => {
  const fields = declaredFields();

  expect({
    max: columns.get("rate_limit_max")?.default,
    window: columns.get("rate_limit_time_window")?.default,
  }).toEqual({
    max: fields.rateLimitMax.defaultValue,
    window: fields.rateLimitTimeWindow.defaultValue,
  });
});

test("the hashed key and its owner are indexed, because every request looks both up", () => {
  const names = getTableConfig(apikey).indexes.map(
    (index) => index.config.name
  );

  expect(names).toContain("apikey_key_idx");
  expect(names).toContain("apikey_referenceId_idx");
});
