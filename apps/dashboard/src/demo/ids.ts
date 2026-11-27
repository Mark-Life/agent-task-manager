/**
 * Ids and instants for the demo's fixtures.
 *
 * Ids are deterministic UUIDs so a link copied from one demo load still opens
 * the same task on the next. Instants are relative to the page load, so a card
 * moved "12 minutes ago" says so whenever the demo is opened.
 */

import { UserId, WorkspaceId } from "@workspace/domain";
import { DateTime } from "effect";

const HEX_WIDTH = 12;
const HEX = 16;

/** One namespace per entity kind, so two kinds never share an id. */
const NAMESPACES = {
  artifact: "a",
  command: "c",
  env: "e",
  event: "f",
  message: "b",
  project: "1",
  proposal: "d",
  run: "3",
  session: "4",
  task: "2",
  thread: "5",
  threadMessage: "6",
} as const;

export type IdKind = keyof typeof NAMESPACES;

/** A valid v7-shaped UUID, the same for the same kind and number. */
export const demoUuid = (kind: IdKind, n: number) =>
  `0199${NAMESPACES[kind]}000-0000-7000-8000-${n.toString(HEX).padStart(HEX_WIDTH, "0")}`;

export const DEMO_WORKSPACE = WorkspaceId.make("ws_demo");
export const DEMO_USER = UserId.make("user_demo");

const MINUTE_MS = 60_000;
const loadedAt = Date.now();

/** An instant `minutes` before the page loaded. */
export const ago = (minutes: number) =>
  DateTime.makeUnsafe(loadedAt - minutes * MINUTE_MS);

/** An instant `minutes` after the page loaded. */
export const ahead = (minutes: number) =>
  DateTime.makeUnsafe(loadedAt + minutes * MINUTE_MS);

export const now = () => DateTime.nowUnsafe();

export const HOUR = 60;
export const DAY = 24 * HOUR;
