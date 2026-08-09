/**
 * The impure half of a prompt: fetch the rows, render them, move the watermark.
 *
 * The text itself lives in `@workspace/prompts`, which is pure and knows
 * nothing about a database. What is left here is the one thing that cannot be
 * pure — reading what the session has not seen and recording that it has now
 * been delivered.
 *
 * Both halves of {@link buildRunPrompt} are one operation because they are one
 * claim: these rows have been handed over. The advance happens at prompt-build
 * time rather than after the run, and that is what stops a resumed run from
 * reading its own auto-appended fallback message back as new input — the
 * session's own previous output is in the conversation like anything else, and
 * a watermark that only moved on rows written by other people would hand the
 * agent its own words as instructions. It advances to the last row actually
 * rendered rather than to the newest row, so a message that lands between the
 * read and the write stays unread instead of being skipped forever.
 *
 * **One watermark, two conversations.** A worker reads messages on its task and
 * a manager reads messages in its thread; both are "what has arrived since this
 * session last looked", answered over the same `(createdAt, id)` tuple by the
 * same `unreadOf`. The branch below is the whole of the difference, and it is
 * what makes coalescing free: every chat message that arrived while a turn was
 * running is still unread when the next one starts, so N of them become one
 * prompt with nothing queueing them.
 *
 * The prompt text never reaches an event: `RunPrompt` carries its own length
 * because `promptChars` is the measurement telemetry records, and a prompt on a
 * row is a task brief in a ledger kept for a year.
 */

import {
  AgentSessionRepo,
  ChatMessageRepo,
  TaskMessageRepo,
  withActor,
} from "@workspace/db";
import type { AgentSession } from "@workspace/domain";
import { ChatMessageId, TaskMessageId } from "@workspace/domain";
import {
  buildManagerPrompt,
  buildWorkerPrompt,
  nextWatermarkOf,
  type RunPlacement,
  type RunPrompt,
  unreadOf,
  type Watermark,
} from "@workspace/prompts";
import {
  type RunWorkspace,
  runTreeOf,
  type SandboxKind,
} from "@workspace/sandbox";
import { Effect } from "effect";
import {
  type DispatchContext,
  sessionIdOf,
  subjectOf,
  workspaceIdOf,
} from "./dispatch-context";
import { PromptBuildFailed } from "./errors";

/** Which sandbox served the run, and the directories it was given. */
export interface PlacementInput {
  readonly kind: SandboxKind;
  readonly workspace: RunWorkspace;
}

/**
 * Where the run's files are, from the run's point of view. The two cases mirror
 * what each sandbox implementation actually does — a container sees its own
 * nested tree, a local process sees the host paths — so the prompt and the
 * process agree on every path in it.
 *
 * The container paths are read off {@link runTreeOf} rather than off a constant,
 * because there is no longer a constant to read: the scopes are spelled with the
 * project's and the task's names, so the checkout a prompt names is the one the
 * mount set puts there only as long as both are computed from the same labels.
 *
 * A local turn has no tree to walk. It is a host process with no mounts, its
 * working directory is `<dataRoot>/workspaces/<runId>`, and the directories
 * above that hold no instruction file — so the host paths are all there is to
 * name, and the house rules the tree would have carried travel in the prompt
 * instead. See {@link PromptRequest.sandboxKind}.
 */
export const placementOf = ({
  kind,
  workspace,
}: PlacementInput): RunPlacement => {
  const { branch } = workspace;
  if (kind === "local") {
    return {
      artifactsDir: workspace.taskArtifactsDir,
      branch,
      globalArtifactsDir: workspace.globalArtifactsDir,
      projectArtifactsDir: workspace.projectArtifactsDir,
      workspaceDir: workspace.workspaceDir,
    };
  }
  const tree = runTreeOf(workspace.labels);
  return {
    artifactsDir: tree.taskScope,
    branch,
    globalArtifactsDir: tree.workspaceScope,
    // Null stays null: a task with no project has no promoted folder mounted,
    // and naming one the run cannot open is worse than not mentioning it. Both
    // nulls are checked because `mountsFor` checks both — a scope named here
    // that the mount set omitted is a path the agent finds empty.
    projectArtifactsDir:
      workspace.projectArtifactsDir === null ? null : tree.projectScope,
    workspaceDir: tree.cwd,
  };
};

/**
 * How far this session has read, as the repository compares it: both halves or
 * neither. A half-set watermark would be a session that reads part of its
 * conversation twice, so the pair is treated as one value everywhere.
 */
export const watermarkOf = (
  session: Pick<AgentSession, "unreadWatermarkAt" | "unreadWatermarkId">
): Watermark | null =>
  session.unreadWatermarkAt === null || session.unreadWatermarkId === null
    ? null
    : { createdAt: session.unreadWatermarkAt, id: session.unreadWatermarkId };

/** One dispatch, and the directories it was given. */
export interface PromptRequest {
  readonly context: DispatchContext;
  readonly placement: RunPlacement;
  /**
   * Which sandbox serves the run, which decides one thing here beyond the paths:
   * whether the standing rules are already on disk where the agent will read
   * them.
   *
   * A container starts inside the tree, so both CLIs collect the instruction
   * files from the workspace scope down before the prompt is even read. A local
   * turn walks parents that hold nothing, so the same rules have to be stated in
   * the text — the prompt carries house style exactly when the filesystem
   * cannot.
   *
   * The kind rather than the boolean, because the placement above answers to the
   * same fact and one of the two would otherwise be set from the other.
   */
  readonly sandboxKind: SandboxKind;
}

/**
 * What one build produced: the text, how many rows went into it, and where the
 * session has now read to. The watermark is computed inside each branch so it
 * keeps the branded id of the table it came from — the column takes either, and
 * a union widened to a bare string would be the place that stops being true.
 */
interface PromptRead {
  readonly prompt: RunPrompt;
  readonly rowsRead: number;
  readonly watermark: {
    readonly createdAt: Watermark["createdAt"];
    readonly id: ChatMessageId | TaskMessageId;
  } | null;
}

/**
 * Builds the prompt and moves the session's watermark past what went into it.
 *
 * The advance is a write and carries the run's own actor, so the audit log
 * names the orchestrator rather than inheriting whoever provided the store.
 *
 * Every database failure becomes {@link PromptBuildFailed}. The run lifecycle
 * above has one thing to do about a prompt it could not build — fail the
 * attempt and let the retry ladder decide — and it should not have to know the
 * difference between a decode error and a dead connection to do it.
 */
export const buildRunPrompt = Effect.fn("Prompt.build")(function* (
  request: PromptRequest
) {
  const { context } = request;
  const { attached } = context;
  const subject = subjectOf(context);
  const workspaceId = workspaceIdOf(context);
  const sessionId = sessionIdOf(context);
  const failed = (cause: unknown) => new PromptBuildFailed({ cause, subject });

  const sessionRepo = yield* AgentSessionRepo;
  const taskMessages = yield* TaskMessageRepo;
  const chatMessages = yield* ChatMessageRepo;

  const watermarkRead = watermarkOf(context.session.session);
  const instructionsOnDisk = request.sandboxKind !== "local";

  /** Everything said on the task since this session last read it. */
  const fromTaskThread = Effect.fnUntraced(function* (
    attachment: Extract<typeof attached, { role: "worker" }>
  ) {
    const returned = yield* taskMessages
      .since({
        taskId: attachment.task.id,
        watermark:
          watermarkRead === null
            ? null
            : {
                createdAt: watermarkRead.createdAt,
                id: TaskMessageId.make(watermarkRead.id),
              },
        workspaceId,
      })
      .pipe(Effect.mapError(failed));
    const unread = unreadOf({ rows: returned, watermark: watermarkRead });
    return {
      prompt: buildWorkerPrompt({
        instructionsOnDisk,
        messages: unread,
        mode: context.session.mode,
        placement: request.placement,
        project: context.project,
        readerSessionId: context.session.session.id,
        repoUrl: context.repoUrl,
        task: attachment.task,
      }),
      rowsRead: unread.length,
      watermark: nextWatermarkOf(unread),
    } satisfies PromptRead;
  });

  /** Everything said in the thread since this session last read it. */
  const fromChatThread = Effect.fnUntraced(function* (
    attachment: Extract<typeof attached, { role: "manager" }>
  ) {
    const returned = yield* chatMessages
      .since({
        threadId: attachment.thread.id,
        watermark:
          watermarkRead === null
            ? null
            : {
                createdAt: watermarkRead.createdAt,
                id: ChatMessageId.make(watermarkRead.id),
              },
        workspaceId,
      })
      .pipe(Effect.mapError(failed));
    const unread = unreadOf({ rows: returned, watermark: watermarkRead });
    return {
      prompt: buildManagerPrompt({
        instructionsOnDisk,
        messages: unread,
        mode: context.session.mode,
        placement: request.placement,
      }),
      rowsRead: unread.length,
      watermark: nextWatermarkOf(unread),
    } satisfies PromptRead;
  });

  const built = yield* attached.role === "worker"
    ? fromTaskThread(attached)
    : fromChatThread(attached);

  if (built.watermark !== null) {
    yield* sessionRepo
      .advanceWatermark({
        id: sessionId,
        unreadAt: built.watermark.createdAt,
        unreadId: built.watermark.id,
        workspaceId,
      })
      .pipe(withActor(context.actor), Effect.mapError(failed));
  }

  yield* Effect.annotateCurrentSpan({
    mode: context.session.mode,
    promptChars: built.prompt.chars,
    role: attached.role,
    rowsRead: built.rowsRead,
    sessionId,
    subjectId: subject.id,
  });

  return built.prompt;
});
