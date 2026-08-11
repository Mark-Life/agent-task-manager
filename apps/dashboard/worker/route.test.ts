import { describe, expect, it } from "bun:test";
import { handlingOf, type RequestFacts } from "./route";

const facts = (over: Partial<RequestFacts> = {}): RequestFacts => ({
  accept: "*/*",
  method: "GET",
  mode: "cors",
  path: "/assets/index-abc123.js",
  sameOrigin: true,
  ...over,
});

describe("what the service worker touches", () => {
  it("takes the build's own files", () => {
    expect(handlingOf(facts())).toBe("asset");
    expect(handlingOf(facts({ path: "/icon-192.png" }))).toBe("asset");
    expect(handlingOf(facts({ path: "/manifest.webmanifest" }))).toBe("asset");
  });

  it("takes a navigation, whatever route it names", () => {
    for (const path of ["/", "/tasks/abc", "/files", "/projects"]) {
      expect(
        handlingOf(facts({ accept: "text/html", mode: "navigate", path }))
      ).toBe("navigate");
    }
  });
});

describe("what it leaves alone", () => {
  it("every call to the gateway, which is a second origin", () => {
    expect(handlingOf(facts({ path: "/tasks", sameOrigin: false }))).toBe(
      "pass-through"
    );
    expect(
      handlingOf(facts({ path: "/assets/index.js", sameOrigin: false }))
    ).toBe("pass-through");
  });

  it("the gateway's paths even when it shares this origin", () => {
    for (const path of [
      "/api/auth/session",
      "/tasks",
      "/tasks/abc/messages",
      "/projects/p1",
      "/threads",
      "/health",
    ]) {
      expect(handlingOf(facts({ path }))).toBe("pass-through");
    }
  });

  it("the run event stream, by its shape and by its Accept header", () => {
    expect(handlingOf(facts({ path: "/tasks/t1/runs/r1/events/stream" }))).toBe(
      "pass-through"
    );
    expect(
      handlingOf(facts({ accept: "text/event-stream", path: "/anything" }))
    ).toBe("pass-through");
  });

  it("anything that is not a plain GET", () => {
    for (const method of ["POST", "PATCH", "DELETE", "PUT", "HEAD"]) {
      expect(handlingOf(facts({ method }))).toBe("pass-through");
    }
  });
});

describe("paths that only look like the gateway's", () => {
  it("are the app's own files", () => {
    // A prefix match on the string alone would swallow these, and the result
    // would be a bundle that never gets cached and a worker nobody suspects.
    expect(handlingOf(facts({ path: "/tasks-summary.js" }))).toBe("asset");
    expect(handlingOf(facts({ path: "/healthcheck.png" }))).toBe("asset");
  });

  it("and a stream path with something after it is not the stream", () => {
    expect(
      handlingOf(facts({ path: "/tasks/t1/runs/r1/events/stream/more" }))
    ).toBe("pass-through");
  });
});
