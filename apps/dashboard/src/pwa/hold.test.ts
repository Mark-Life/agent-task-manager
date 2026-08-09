import { describe, expect, it } from "bun:test";
import { hold, holdReasons, isHeld, onHoldsChange } from "@/pwa/hold";

describe("holding off a reload", () => {
  it("is nothing until somebody asks", () => {
    expect(isHeld()).toBe(false);
    expect(holdReasons()).toEqual([]);
  });

  it("releases only the hold that was taken", () => {
    const first = hold("a message is half written");
    const second = hold("a file is open in the editor");

    expect(holdReasons()).toHaveLength(2);
    first();
    expect(holdReasons()).toEqual(["a file is open in the editor"]);
    second();
    expect(isHeld()).toBe(false);
  });

  it("counts two holds for the same reason separately", () => {
    // Two boxes open at once report one reason between them, and the update
    // stays held until both are closed.
    const one = hold("something is being edited");
    const two = hold("something is being edited");

    expect(holdReasons()).toEqual(["something is being edited"]);
    one();
    expect(isHeld()).toBe(true);
    two();
    expect(isHeld()).toBe(false);
  });

  it("ignores a second release of the same hold", () => {
    const release = hold("a run is being watched");
    release();
    release();
    expect(isHeld()).toBe(false);
  });

  it("tells listeners when the answer changes", () => {
    let changes = 0;
    const stop = onHoldsChange(() => {
      changes += 1;
    });

    const release = hold("a run is being watched");
    release();
    stop();
    hold("ignored")();

    expect(changes).toBe(2);
  });
});
