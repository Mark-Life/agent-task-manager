import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Actor, flattenActor } from "./actor";
import { ACTOR_KINDS, type ActorKind } from "./enums";
import {
  newAgentSessionId,
  newRunId,
  newTaskId,
  UserId,
  type WorkspaceId,
} from "./ids";

const userId = UserId.make("8f6ba3cc0d2a4a0f9b1f7e2c5d3a6b41");
const runId = newRunId();
const sessionId = newAgentSessionId();
const taskId = newTaskId();

const samples = {
  human: Actor.cases.human.make({ userId }),
  manager: Actor.cases.manager.make({ threadId: "thread-1", userId }),
  orchestrator: Actor.cases.orchestrator.make({
    loopInstance: "loop-1",
    runId,
  }),
  system: Actor.cases.system.make({ reason: "seed" }),
  worker_run: Actor.cases.worker_run.make({ runId, sessionId, taskId }),
} satisfies Record<ActorKind, Actor>;

describe("Actor", () => {
  test("its discriminant is exactly the ActorKind union", () => {
    expect(new Set(Actor.discriminants)).toEqual(new Set(ACTOR_KINDS));
  });

  test("round-trips through its schema", () => {
    const decode = Schema.decodeUnknownSync(Actor);
    const encode = Schema.encodeSync(Actor);
    for (const actor of Object.values(samples)) {
      expect(decode(encode(actor))).toEqual(actor);
    }
  });

  test("rejects a variant missing the ids it needs", () => {
    expect(() =>
      Schema.decodeUnknownSync(Actor)({ kind: "worker_run", runId })
    ).toThrow();
  });
});

describe("flattenActor", () => {
  test("attributes every actor kind, never to nobody", () => {
    for (const kind of ACTOR_KINDS) {
      expect(flattenActor(samples[kind]).actorKind).toBe(kind);
    }
  });

  test("a worker write names its run and its session", () => {
    expect(flattenActor(samples.worker_run)).toEqual({
      actorKind: "worker_run",
      actorRunId: runId,
      actorSessionId: sessionId,
      actorThreadId: null,
      actorUserId: null,
    });
  });

  test("a manager write names the conversation behind it", () => {
    expect(flattenActor(samples.manager)).toEqual({
      actorKind: "manager",
      actorRunId: null,
      actorSessionId: null,
      actorThreadId: "thread-1",
      actorUserId: userId,
    });
  });

  test("an id of the wrong entity does not compile into an actor", () => {
    const workspaceId = "wk" as WorkspaceId;
    // @ts-expect-error a workspace id is not a user id, even though both are text
    const actor = Actor.cases.human.make({ userId: workspaceId });
    expect(actor.kind).toBe("human");
  });
});
