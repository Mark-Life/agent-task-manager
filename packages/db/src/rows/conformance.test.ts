/**
 * One test per table, and each is a compile-time assertion wearing a test's
 * clothes: `conforms` only accepts `true` when the decoded row and the domain
 * entity are the same type, so a column added to a table without a matching
 * domain field, a field renamed on either side, or a brand lost on the way
 * through, all fail `bun run typecheck` here rather than surfacing as a cast
 * that was never true.
 *
 * The runtime half of each assertion is trivial on purpose. The value is in the
 * argument the compiler had to accept.
 */

import { expect, test } from "bun:test";
import type {
  AgentSession,
  Artifact,
  AuditEntry,
  ChatMessage,
  ChatNotification,
  ChatThread,
  Comment,
  Project,
  Run,
  RunCommand,
  RunEvent,
  Task,
  Workspace,
} from "@workspace/domain";
import type { decodeAgentSession } from "./agent-session";
import type { decodeArtifact } from "./artifact";
import type { decodeAuditEntry } from "./audit";
import type {
  decodeChatMessage,
  decodeChatNotification,
  decodeChatThread,
} from "./chat";
import type { decodeComment } from "./comment";
import { conforms, type Decoded } from "./conformance";
import type { decodeProject } from "./project";
import type { decodeRun } from "./run";
import type { decodeRunCommand } from "./run-command";
import type { decodeRunEvent } from "./run-event";
import type { decodeTask } from "./task";
import type { decodeWorkspace } from "./workspace";

test("a decoded project is a Project", () => {
  expect(conforms<Decoded<typeof decodeProject>, Project>(true)).toBe(true);
});

test("a decoded task is a Task", () => {
  expect(conforms<Decoded<typeof decodeTask>, Task>(true)).toBe(true);
});

test("a decoded comment is a Comment", () => {
  expect(conforms<Decoded<typeof decodeComment>, Comment>(true)).toBe(true);
});

test("a decoded agent session is an AgentSession", () => {
  expect(conforms<Decoded<typeof decodeAgentSession>, AgentSession>(true)).toBe(
    true
  );
});

test("a decoded run is a Run", () => {
  expect(conforms<Decoded<typeof decodeRun>, Run>(true)).toBe(true);
});

test("a decoded run event is a RunEvent, tag rejoined with its payload", () => {
  expect(conforms<Decoded<typeof decodeRunEvent>, RunEvent>(true)).toBe(true);
});

test("a decoded run command is a RunCommand, tag rejoined with its payload", () => {
  expect(conforms<Decoded<typeof decodeRunCommand>, RunCommand>(true)).toBe(
    true
  );
});

test("a decoded artifact is an Artifact", () => {
  expect(conforms<Decoded<typeof decodeArtifact>, Artifact>(true)).toBe(true);
});

test("a decoded audit entry is an AuditEntry", () => {
  expect(conforms<Decoded<typeof decodeAuditEntry>, AuditEntry>(true)).toBe(
    true
  );
});

test("a decoded chat thread is a ChatThread", () => {
  expect(conforms<Decoded<typeof decodeChatThread>, ChatThread>(true)).toBe(
    true
  );
});

test("a decoded chat message is a ChatMessage", () => {
  expect(conforms<Decoded<typeof decodeChatMessage>, ChatMessage>(true)).toBe(
    true
  );
});

test("a decoded chat notification is a ChatNotification", () => {
  expect(
    conforms<Decoded<typeof decodeChatNotification>, ChatNotification>(true)
  ).toBe(true);
});

test("a decoded organization row is a Workspace", () => {
  expect(conforms<Decoded<typeof decodeWorkspace>, Workspace>(true)).toBe(true);
});
