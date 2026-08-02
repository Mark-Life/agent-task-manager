/**
 * A security flag only exercised by starting a real container is a security flag
 * that gets dropped in a refactor and noticed by nobody. These assert the argv
 * itself: every confinement the sandbox claims is in the array, and the flags
 * that would undo them are absent.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MEMORY_MB,
  defaultHardening,
  hardeningArgs,
  tmpfsArg,
} from "./hardening";

const args = hardeningArgs(defaultHardening);

describe("hardeningArgs", () => {
  test("drops every capability and blocks privilege escalation", () => {
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges:true");
  });

  test("never adds a capability, privilege or host namespace back", () => {
    const joined = args.join(" ");
    expect(joined).not.toContain("--cap-add");
    expect(joined).not.toContain("--privileged");
    expect(joined).not.toContain("--pid=host");
    expect(joined).not.toContain("--network=host");
  });

  test("runs as a non-root user", () => {
    const user = args.find((arg) => arg.startsWith("--user="));
    expect(user).toBeDefined();
    expect(user).not.toBe("--user=0:0");
    expect(user).not.toBe("--user=root");
  });

  test("caps processes, memory and cpu", () => {
    expect(args).toContain("--pids-limit=512");
    expect(args).toContain(`--memory=${DEFAULT_MEMORY_MB}m`);
    expect(args).toContain("--cpus=1.5");
  });

  test("forbids swap by matching the swap ceiling to the memory ceiling", () => {
    expect(defaultHardening.memorySwapMb).toBe(defaultHardening.memoryMb);
    expect(args).toContain(`--memory-swap=${DEFAULT_MEMORY_MB}m`);
  });

  test("leaves the network open, and says so in the argv", () => {
    expect(args).toContain("--network=bridge");
  });

  test("reaps children with an init process", () => {
    expect(args).toContain("--init");
  });

  test("gives /tmp a capped tmpfs with no setuid and no device nodes", () => {
    const tmpfs = args.find((arg) => arg.startsWith("--tmpfs="));
    expect(tmpfs).toBe("--tmpfs=/tmp:rw,nosuid,nodev,size=512m,mode=1777");
  });

  test("leaves the rootfs writable by default and honours the flag", () => {
    expect(args).not.toContain("--read-only");
    expect(
      hardeningArgs({ ...defaultHardening, readOnlyRootfs: true })
    ).toContain("--read-only");
  });
});

describe("tmpfsArg", () => {
  test("writes the mode in octal, as docker reads it", () => {
    expect(tmpfsArg({ mode: 0o700, path: "/scratch", sizeMb: 64 })).toBe(
      "--tmpfs=/scratch:rw,nosuid,nodev,size=64m,mode=700"
    );
  });
});
