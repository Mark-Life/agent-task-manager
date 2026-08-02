/**
 * The classifier decides what the orchestrator does next — pause the queue,
 * rebuild an image, retry on a smaller cap, or give up — so the cases worth
 * pinning are the ambiguous ones: a SIGKILL that is not an OOM, a daemon message
 * that also names an image, and a container command that failed on its own terms
 * and is not a sandbox failure at all.
 */

import { describe, expect, test } from "bun:test";
import {
  classifySandboxFailure,
  DaemonUnreachable,
  DOCKER_EXIT_CODES,
  describeError,
  keepStderrTail,
  OomKilled,
  outcomeOfClass,
  STDERR_TAIL_CHARS,
} from "./errors";

describe("classifySandboxFailure", () => {
  test("a typed failure already knows what it is", () => {
    expect(
      classifySandboxFailure({
        thrown: new DaemonUnreachable({ detail: "socket gone" }),
      })
    ).toBe("DaemonUnreachable");
  });

  test("the inspect flag outranks 137, which a teardown also produces", () => {
    expect(
      classifySandboxFailure({
        exitCode: DOCKER_EXIT_CODES.sigkill,
        oomKilled: true,
      })
    ).toBe("OomKilled");
    expect(
      classifySandboxFailure({
        exitCode: DOCKER_EXIT_CODES.sigkill,
        oomKilled: false,
      })
    ).toBe("Unknown");
  });

  test("a dead daemon is not a missing image, even when it names one", () => {
    expect(
      classifySandboxFailure({
        exitCode: DOCKER_EXIT_CODES.daemonError,
        stderr:
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running? unable to find image atm-base:1",
      })
    ).toBe("DaemonUnreachable");
  });

  test("a pull that found nothing is a missing image", () => {
    expect(
      classifySandboxFailure({
        exitCode: 1,
        stderr: "Error response from daemon: manifest unknown",
      })
    ).toBe("ImageMissing");
  });

  test("a bad bind source is named as one, not as a start failure", () => {
    expect(
      classifySandboxFailure({
        exitCode: DOCKER_EXIT_CODES.daemonError,
        stderr:
          "docker: Error response from daemon: invalid mount config for type bind: bind source path does not exist: /data/tasks/t1/artifacts",
      })
    ).toBe("MountSourceMissing");
  });

  test("docker's own exit codes are a start failure", () => {
    expect(
      classifySandboxFailure({ exitCode: DOCKER_EXIT_CODES.notFound })
    ).toBe("ContainerStartFailed");
    expect(
      classifySandboxFailure({ exitCode: DOCKER_EXIT_CODES.notExecutable })
    ).toBe("ContainerStartFailed");
  });

  test("a command that exited non-zero on its own terms is not a sandbox failure", () => {
    expect(
      classifySandboxFailure({ exitCode: 1, stderr: "3 tests failed" })
    ).toBe("Unknown");
  });
});

describe("outcomeOfClass", () => {
  test("everything that happened before the command ran counts as start_failed", () => {
    expect(outcomeOfClass("DaemonUnreachable")).toBe("start_failed");
    expect(outcomeOfClass("ImageMissing")).toBe("start_failed");
    expect(outcomeOfClass("MountSourceMissing")).toBe("start_failed");
    expect(outcomeOfClass("CloneFailed")).toBe("start_failed");
  });

  test("a kernel kill keeps its own literal", () => {
    expect(outcomeOfClass("OomKilled")).toBe("oom_killed");
  });
});

describe("describeError", () => {
  test("names the class, the outcome and a sanitized message", () => {
    expect(
      describeError(new OomKilled({ containerId: "abc123", limitMb: 2048 }))
    ).toEqual({
      errorClass: "OomKilled",
      errorMessage: "killed by the kernel at the 2048MB limit",
      outcome: "oom_killed",
    });
  });

  test("redacts a credential a daemon echoed back", () => {
    const described = describeError(
      new DaemonUnreachable({
        detail: "registry auth failed: Bearer sk-abcdefghijklmnop",
      })
    );
    expect(described.errorMessage).not.toContain("sk-abcdefghijklmnop");
    expect(described.errorMessage).toContain("[redacted]");
  });
});

describe("keepStderrTail", () => {
  test("keeps the end, where the reason is, not the progress at the start", () => {
    const text = `${"progress ".repeat(1000)}the real reason`;
    const tail = keepStderrTail(text);
    expect(tail.length).toBe(STDERR_TAIL_CHARS);
    expect(tail.endsWith("the real reason")).toBe(true);
  });
});
