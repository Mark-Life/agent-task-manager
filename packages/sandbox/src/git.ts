/**
 * Running `git` and `gh` on the host, with the one rule that makes it safe to
 * trace.
 *
 * A version-control command line is a credential. `git clone
 * https://x-access-token:ghs_…@github.com/owner/name` and `gh api -H
 * "Authorization: token …"` both carry a live token in argv, and git echoes the
 * remote back in its own error text. So this module is built around three
 * places that would otherwise leak one, each closed here rather than at a call
 * site:
 *
 * The span. It goes through `withSubprocessSpan`, which is this package's single
 * implementation of "a span is named by its subcommand and never by its argv" —
 * the same one the docker module uses. There is no way to pass a label in: the
 * rule reads the argv itself and refuses any token that is not a bare word, so a
 * URL, a branch name or a header value cannot become a span name however the
 * caller composes the command. The argv is never an attribute of anything.
 *
 * The error. {@link GitCommand.repo} is what a failure is named after, and it
 * is a slug the caller already holds rather than the clone URL — the URL is the
 * thing with the token in it. Everything read back off the process passes
 * {@link redactRemote} before it reaches {@link CloneFailed}, because git's own
 * message quotes the remote whether or not the caller was careful.
 *
 * The executable. A closed union of two, so this is a runner for the two tools
 * this system shells out to and not a general-purpose `exec` that later grows a
 * caller passing a string from a database row.
 *
 * Non-zero exit is data on {@link GitResult}, matching the sandbox's own rule:
 * `git rev-parse --verify` answering "no" is not a broken subprocess.
 * {@link GitInterface.mustRun} is the opt-in for the commands where it is.
 */

import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Context, Effect, Layer, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { CloneFailed, keepStderrTail } from "./errors";
import { subcommandOf, withSubprocessSpan } from "./sandbox-event";

/**
 * The two binaries this system shells out to. Closed, so the runner cannot be
 * handed a command name that came from a row or a prompt.
 */
export const GIT_EXECUTABLES = ["git", "gh"] as const;

/** Which binary a command invokes. */
export type GitExecutable = (typeof GIT_EXECUTABLES)[number];

/**
 * Credential shapes that appear in git and gh output, in the order they are
 * stripped. The userinfo rule is first and is the one that matters: git quotes
 * the remote it failed to reach, so a clone URL built with an installation
 * token puts that token into stderr without anyone passing it anywhere.
 */
const REMOTE_SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/(\w+:\/\/)[^/@\s]+@/g, "$1[redacted]@"],
  [/\bgh[posru]_[A-Za-z0-9]{16,}/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted]"],
];

/**
 * Strips the credential shapes a version-control tool prints. Applied to
 * everything read off the process before it lands on an error, because the
 * shared sanitizer covers bearer tokens and API keys but not the `user:pass@`
 * that a clone URL carries. Pure.
 */
export const redactRemote = (text: string) =>
  REMOTE_SECRET_PATTERNS.reduce(
    (accumulated, [pattern, replacement]) =>
      accumulated.replace(pattern, replacement),
    text
  );

/** One invocation: what to run, where, and what a failure is named after. */
export interface GitCommand {
  readonly args: readonly string[];
  /** Working directory, or null to inherit the host process's. */
  readonly cwd: string | null;
  readonly executable: GitExecutable;
  /**
   * What a failure reports. A slug or a directory the caller already holds —
   * never the clone URL, which is where the token is.
   */
  readonly repo: string;
}

/** What one invocation produced. A non-zero exit is data, not a failure. */
export interface GitResult {
  readonly exitCode: number;
  /** Redacted and tail-clipped. */
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * The environment every invocation is given, over the host's own.
 *
 * `GIT_TERMINAL_PROMPT=0` is the load-bearing one. A private repo with no
 * usable credential makes git block on a username prompt against a stdin
 * nothing will ever write to, and a materialization that hangs holds a
 * dispatch slot until someone notices. Refusing is the failure the
 * orchestrator can act on.
 */
const NON_INTERACTIVE_ENV = {
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
} as const;

/**
 * How long a killed process has to exit before it is killed harder. The scope
 * sends SIGTERM on interrupt; a clone stuck in a network read ignores it.
 */
const FORCE_KILL_AFTER = "5 seconds";

/** The failure a process that could not be run at all comes back as. */
const spawnFailure = (command: GitCommand, cause: unknown) =>
  new CloneFailed({
    exitCode: null,
    repo: command.repo,
    stderr: redactRemote(String(cause)),
  });

/** Runs git or gh, capturing both streams. */
export interface GitInterface {
  /**
   * Runs the command and fails with {@link CloneFailed} on a non-zero exit.
   * For the invocations where a failure is the run's failure.
   */
  readonly mustRun: (
    command: GitCommand
  ) => Effect.Effect<GitResult, CloneFailed>;
  /**
   * Runs the command and answers with everything it produced. Fails only when
   * the process could not be run — a non-zero exit is on the result.
   */
  readonly run: (command: GitCommand) => Effect.Effect<GitResult, CloneFailed>;
}

/**
 * The runner over an already-resolved spawner. Exported so a test can drive it
 * without building the Bun platform layer, and so the layer below is nothing
 * but wiring.
 */
export const makeGit = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner;

  const run = (command: GitCommand) =>
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command.executable, [...command.args], {
          cwd: command.cwd ?? undefined,
          env: NON_INTERACTIVE_ENV,
          // The binary is found on the host's `PATH`, so the child's
          // environment is the host's with the refusals above layered over it.
          extendEnv: true,
          forceKillAfter: FORCE_KILL_AFTER,
        })
      );
      // Both streams are drained concurrently with the exit wait: an undrained
      // pipe fills and stops the child, and a clone that prints more progress
      // than a pipe holds would deadlock instead of finishing.
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: "unbounded" }
      );
      return {
        exitCode: Number(exitCode),
        stderr: keepStderrTail(redactRemote(stderr)),
        stdout,
      } satisfies GitResult;
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) => spawnFailure(command, cause)),
      Effect.tap((result) =>
        Effect.annotateCurrentSpan({ exitCode: result.exitCode })
      ),
      // The label is derived by the shared rule and cannot be supplied: this is
      // the single point where an argv could have become a span name, and it
      // does not. `repo` is a slug the caller already holds, never the clone
      // URL — that is the string with the token in it.
      withSubprocessSpan(command.executable, command.args, {
        repo: command.repo,
        subcommand: subcommandOf(command.args) ?? "exec",
      })
    );

  const mustRun = (command: GitCommand) =>
    Effect.flatMap(run(command), (result) =>
      result.exitCode === 0
        ? Effect.succeed(result)
        : Effect.fail(
            new CloneFailed({
              exitCode: result.exitCode,
              repo: command.repo,
              // stdout only when stderr is silent: some git plumbing reports
              // its refusal on stdout, and an empty message classifies as
              // `Unknown` and tells a reader nothing.
              stderr:
                result.stderr.trim() ||
                keepStderrTail(redactRemote(result.stdout)),
            })
          )
    );

  return Git.of({ mustRun, run });
});

/**
 * Bun's process spawner and the two services it is built from. Named
 * explicitly rather than taken from the aggregate platform layer, which would
 * also construct a terminal and claim the host's stdin.
 */
const spawnerLayer = BunChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))
);

/**
 * Version-control subprocesses as a service, so repo materialization can be
 * driven against a scripted runner in a test without a temp repo, and so the
 * span and redaction rules above have exactly one implementation.
 */
export class Git extends Context.Service<Git, GitInterface>()(
  "@workspace/sandbox/Git"
) {
  static readonly layer = Layer.effect(Git, makeGit).pipe(
    Layer.provide(spawnerLayer)
  );
}
