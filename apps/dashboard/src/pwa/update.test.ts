import { describe, expect, it } from "bun:test";
import { blockedBy } from "@/pwa/update";

describe("whether a waiting build may be adopted", () => {
  it("says so when there is nothing waiting", () => {
    expect(blockedBy({ reasons: [], waiting: false })).toBe(
      "there is no new build waiting"
    );
  });

  it("adopts when a build is waiting and nothing is held", () => {
    expect(blockedBy({ reasons: [], waiting: true })).toBeNull();
  });

  it("names the hold in the way of it", () => {
    expect(
      blockedBy({
        reasons: ["a message is half written", "a run is being watched"],
        waiting: true,
      })
    ).toBe("a message is half written");
  });

  it("refuses on a hold even though a build is ready", () => {
    // The whole point: a downloaded build waits rather than reloading over
    // somebody's unsaved work.
    expect(
      blockedBy({ reasons: ["a file is open in the editor"], waiting: true })
    ).not.toBeNull();
  });
});
