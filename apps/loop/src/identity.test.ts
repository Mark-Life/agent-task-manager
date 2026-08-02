import { describe, expect, it } from "bun:test";
import process from "node:process";
import { loopInstanceId, orchestratorActor, SERVICE_NAME } from "./identity";

describe("loopInstanceId", () => {
  it("names the process a signal would be sent to", () => {
    expect(loopInstanceId()).toContain(`/${process.pid}/`);
  });

  it("is different on every boot, so a reused pid is a different instance", () => {
    // The whole reason the id is not `host/pid`: a supervisor restarting a
    // crashed loop can be handed the same pid, and the new process must not
    // read the dead one's stale lease as its own.
    expect(loopInstanceId()).not.toBe(loopInstanceId());
  });
});

describe("orchestratorActor", () => {
  it("is the orchestrator, carrying the instance and no run", () => {
    const actor = orchestratorActor("host/42/deadbeef");
    expect(actor.kind).toBe("orchestrator");
    expect(actor).toEqual({
      kind: "orchestrator",
      loopInstance: "host/42/deadbeef",
    });
  });
});

describe("SERVICE_NAME", () => {
  it("is the ledger file `bun run logs` reads", () => {
    expect(SERVICE_NAME).toBe("loop");
  });
});
