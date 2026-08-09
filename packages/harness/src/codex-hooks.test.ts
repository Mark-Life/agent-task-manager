import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { serve, spawn, which } from "bun";
import { Effect } from "effect";
import { codexArgs } from "./codex";
import { codexHooksFile, codexHooksPath, writeCodexHooks } from "./codex-hooks";
import type { RunOptions } from "./provider";
import { NO_MESSAGE_REFUSAL, STOP_HOOK_COMMAND_ENV_VAR } from "./stop-hook";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codex-hooks-"));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

describe("codexHooksFile", () => {
  test("registers the configured command on Stop and on nothing else", () => {
    const command = "bun /opt/atm/turn.js --stop-hook";
    expect(
      codexHooksFile({ [STOP_HOOK_COMMAND_ENV_VAR]: command })
    ).toStrictEqual({
      description: expect.any(String),
      // `SubagentStop` is deliberately absent: it would hold a subagent open
      // over a message the parent turn has not had a chance to post.
      hooks: { Stop: [{ hooks: [{ command, type: "command" }] }] },
    });
  });

  test("is absent when the environment names no command", () => {
    expect(codexHooksFile({})).toBeNull();
    expect(codexHooksFile({ [STOP_HOOK_COMMAND_ENV_VAR]: "  " })).toBeNull();
  });
});

describe("writeCodexHooks", () => {
  const write = (env: Readonly<Record<string, string | undefined>>) =>
    Effect.runPromise(
      writeCodexHooks({ agentHomeDir: join(root, "codex"), env }).pipe(
        Effect.provide(BunFileSystem.layer)
      )
    );

  test("writes the definition into an agent home that does not exist yet", async () => {
    expect(await write({ [STOP_HOOK_COMMAND_ENV_VAR]: "/bin/true" })).toBe(
      true
    );
    expect(
      JSON.parse(readFileSync(codexHooksPath(join(root, "codex")), "utf8"))
    ).toEqual(codexHooksFile({ [STOP_HOOK_COMMAND_ENV_VAR]: "/bin/true" }));
  });

  test("writes nothing when no command is configured", async () => {
    expect(await write({})).toBe(false);
  });
});

/**
 * The stub the turn is served by: one `/responses` call answers with the same
 * assistant message every time. Only the model is stubbed — the CLI, the hook
 * process and the file it is registered through are all real.
 */
const startStubModel = (asked: string[]) =>
  serve({
    fetch: async (request) => {
      if (!new URL(request.url).pathname.endsWith("/responses")) {
        return new Response("{}");
      }
      asked.push(await request.text());
      const message = {
        content: [{ text: "ping", type: "output_text" }],
        id: "msg_1",
        role: "assistant",
        status: "completed",
        type: "message",
      };
      const body = [
        { response: { id: "resp_1" }, type: "response.created" },
        { item: message, output_index: 0, type: "response.output_item.done" },
        { response: { id: "resp_1" }, type: "response.completed" },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("");
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
    port: 0,
  });

/** Points Codex at the stub instead of at an account. */
const stubConfigToml = (baseUrl: string) => `model = "fake-model"
model_provider = "stub"

[model_providers.stub]
name = "stub"
base_url = "${baseUrl}"
wire_api = "responses"
env_key = "ATM_STUB_MODEL_KEY"
requires_openai_auth = false
`;

/**
 * A real `codex exec`, hooks and all. Skipped where the CLI is not installed:
 * the point of this test is the format the installed binary reads, and a
 * substitute for the binary would assert nothing.
 */
const describeCli = which("codex") === null ? describe.skip : describe;

describeCli("codex exec with the registered stop hook", () => {
  const stopHookScript = join(import.meta.dir, "..", "scripts", "stop-hook.ts");

  const runTurn = async (input: { readonly messagePosted: boolean }) => {
    const asked: string[] = [];
    const server = startStubModel(asked);
    const agentHomeDir = join(root, "codex");
    const workspaceDir = join(root, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    const marker = join(root, "message-posted");
    if (input.messagePosted) {
      writeFileSync(marker, "");
    }
    const env = {
      ATM_MESSAGE_MARKER: marker,
      ATM_STUB_MODEL_KEY: "stub-key",
      [STOP_HOOK_COMMAND_ENV_VAR]: `bun ${stopHookScript}`,
    };
    try {
      await Effect.runPromise(
        writeCodexHooks({ agentHomeDir, env }).pipe(
          Effect.provide(BunFileSystem.layer)
        )
      );
      writeFileSync(
        join(agentHomeDir, "config.toml"),
        stubConfigToml(`${server.url.origin}/v1`)
      );
      const options: RunOptions = {
        agentHomeDir,
        effort: null,
        env: {},
        mcpServers: null,
        model: null,
        prompt: "say ping",
        resumeSessionId: null,
        runId: null,
        signal: null,
        taskId: null,
        workspaceDir,
      };
      const child = spawn(["codex", ...codexArgs(options)], {
        cwd: root,
        env: { ...process.env, ...env, CODEX_HOME: agentHomeDir },
        stdin: new TextEncoder().encode(options.prompt),
        stdout: "pipe",
      });
      const stdout = await new Response(child.stdout).text();
      await child.exited;
      return { asked, stdout };
    } finally {
      await server.stop(true);
    }
  };

  test("sends a turn that posted no message back exactly once", async () => {
    const { asked, stdout } = await runTurn({ messagePosted: false });
    expect(stdout).toContain('"turn.completed"');
    // Two model calls: the turn, and the one the refusal forced. A third
    // would mean `stop_hook_active` was ignored, and Codex caps nothing.
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain(NO_MESSAGE_REFUSAL);
  }, 120_000);

  test("lets a turn that posted one end on its first attempt", async () => {
    const { asked } = await runTurn({ messagePosted: true });
    expect(asked).toHaveLength(1);
  }, 120_000);
});
