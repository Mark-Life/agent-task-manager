#!/usr/bin/env bun

/**
 * Fills the workspace with a board worth looking at: every column occupied,
 * and every state a card can be in represented at least once — a live run, a
 * task waiting for a slot, a parked one, a pull request, a crash.
 *
 * Written for working on the dashboard rather than for testing the store. The
 * check scripts drive one path end to end and leave one task behind; this
 * writes the spread a person iterating on the UI needs in front of them, so a
 * spinner, a `parked` badge and a failed run's timeline are all on screen
 * without waiting for the orchestrator to produce them.
 *
 * Re-runnable: the demo project is found by name, and finding it means every
 * row below it is already there, so a second run writes nothing.
 *
 * Usage: `bun run db:seed:demo`. Needs the migrations applied first.
 */

import { BunRuntime } from "@effect/platform-bun";
import {
  AgentSessionRepo,
  ChatMessageRepo,
  ChatThreadRepo,
  ProjectRepo,
  RunEventRepo,
  RunRepo,
  storeLayer,
  type TaskCreate,
  TaskMessageRepo,
  TaskRepo,
  withActor,
} from "@workspace/db";
import {
  Actor,
  CostUsd,
  type ProjectId,
  type RunEventPayload,
  type RunId,
  type Task,
  type UserId,
  type WorkspaceId,
} from "@workspace/domain";
import { DateTime, Duration, Effect } from "effect";
import { ensureWorkspace } from "./store/workspace";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "seed-demo";

/** The rows land as nobody in particular, the same way the first seed's do. */
const SEEDER = Actor.cases.system.make({ reason: "seed-demo" });

/** Stands in for the loop, which is not running while somebody works on the UI. */
const LOOP_INSTANCE = "seed-demo";

/**
 * The project whose presence means this script has already run. Named for the
 * work rather than for the seed, because it sits on the board beside real
 * projects and a card badged "demo" tells a reader nothing about the layout.
 */
const MARKER_PROJECT = "Website relaunch";

/** The second project, so a card's project badge is not a constant. */
const SECOND_PROJECT = "Mobile client";

/** How far ahead a parked task is parked, which is what draws the badge. */
const PARK_AHEAD = Duration.hours(2);

/**
 * How much of a run's timeline a live attempt has produced: everything up to
 * the turn it is in the middle of, and nothing that would close it out.
 */
const EVENTS_BEFORE_LIVE = 5;

/** Where a demo pull request points. Nothing follows the link. */
const PR_BASE = "https://github.com/Mark-Life/agent-task-manager/pull";

const projectsOf = (workspaceId: WorkspaceId) =>
  [
    {
      description: "The public site, its copy and its theme.",
      name: MARKER_PROJECT,
      repoDefaultBranch: "main",
      repoUrl: "https://github.com/Mark-Life/website",
      workspaceId,
    },
    {
      description: "The phone client that reads the same board.",
      name: SECOND_PROJECT,
      repoDefaultBranch: "main",
      repoUrl: "https://github.com/Mark-Life/mobile-client",
      workspaceId,
    },
  ] as const;

/** The projects a task can be filed under, by the name the seed knows them by. */
interface Projects {
  readonly mobile: ProjectId;
  readonly website: ProjectId;
}

/**
 * The board, written out. Each entry is created straight into its column — the
 * status machine has no entry for the `system` actor, so a seeded card never
 * walks the columns it would have walked.
 *
 * The spread is deliberate: a column holds cards with and without a project,
 * with and without a pull request, and with titles both short enough and long
 * enough to show what the card does at three lines.
 */
const tasksOf = (options: Projects & { readonly workspaceId: WorkspaceId }) => {
  const { mobile, website, workspaceId } = options;
  return [
    {
      brief: "Nothing decided. Somebody said it out loud once.",
      status: "ideas",
      title: "Voice notes become tasks without a round trip",
      workspaceId,
    },
    {
      brief: "A long title, kept here on purpose to show where a card clips.",
      projectId: website,
      status: "ideas",
      title:
        "Decide whether the marketing site and the dashboard should share one design system, or whether the two are different enough that a shared one costs more than it saves",
      workspaceId,
    },
    {
      acceptance: "One form, one submit, no tab strip.",
      brief: "Three tabs of settings, each with its own save button.",
      projectId: website,
      status: "backlog",
      title: "Rewrite the settings page as a single form",
      workspaceId,
    },
    {
      brief: "The board read is the slowest thing on a cold start.",
      projectId: mobile,
      status: "backlog",
      title: "Cache the board behind a stale-while-revalidate window",
      workspaceId,
    },
    {
      brief: "Every surface, not only the board.",
      projectId: website,
      status: "in_progress",
      title: "Dark theme pass over the whole dashboard",
      workspaceId,
    },
    {
      brief: "Moves made offline should land in order once the phone is back.",
      projectId: mobile,
      status: "in_progress",
      title: "Offline queue for card moves",
      workspaceId,
    },
    {
      brief: "Two icon sets in one build is one too many.",
      status: "in_progress",
      title: "Migrate the icon set",
      workspaceId,
    },
    {
      acceptance: "A wrong password says so without saying which field.",
      brief: "The sign-in page is the only unauthenticated screen.",
      projectId: website,
      prUrl: `${PR_BASE}/41`,
      status: "review",
      title: "Sign-in page states and error copy",
      workspaceId,
    },
    {
      brief: "The token registration call fails on a cold install.",
      projectId: mobile,
      status: "review",
      title: "Push notification registration",
      workspaceId,
    },
    {
      brief: "Title, brief and message bodies, ranked by recency.",
      prUrl: `${PR_BASE}/38`,
      status: "review",
      title: "Search across tasks",
      workspaceId,
    },
    {
      brief: "One page, one headline, one call to action.",
      projectId: website,
      prUrl: `${PR_BASE}/33`,
      status: "done",
      title: "Ship the marketing page",
      workspaceId,
    },
    {
      brief: "Typecheck, lint and tests on every push.",
      status: "done",
      title: "CI on every push",
      workspaceId,
    },
  ] as const satisfies readonly TaskCreate[];
};

/** Finds a seeded task by its title, which is what the writes below address it by. */
const taskNamed = (tasks: readonly Task[], title: string) => {
  const found = tasks.find((task) => task.title.startsWith(title));
  if (found === undefined) {
    throw new Error(`the seed did not write a task titled ${title}`);
  }
  return found;
};

/** A run's timeline, as the harness would have written it line by line. */
const workerEvents = (
  options: { readonly failing: boolean } = { failing: false }
) =>
  [
    {
      kind: "started",
      model: "claude-opus-5",
      promptChars: 1840,
      provider: "claude",
      sandboxImage: "atm-base:arm64",
    },
    { kind: "log", level: "info", message: "cloning the repository" },
    {
      callId: "call_1",
      inputChars: 96,
      kind: "tool_call",
      summary: "read apps/dashboard/src/features/board/card.tsx",
      toolName: "Read",
    },
    {
      callId: "call_1",
      kind: "tool_result",
      ok: true,
      outputChars: 4210,
      summary: "171 lines",
    },
    { chars: 640, kind: "reasoning" },
    {
      chars: 214,
      kind: "assistant_message",
      text: "The card renders its footer only when it has something to put in it, so the badge belongs beside the marker rather than in a row of its own.",
    },
    {
      costUsd: CostUsd.make("0.83"),
      inputTokens: 41_200,
      kind: "usage",
      outputTokens: 3100,
      rateLimitPct: 18,
      turns: 6,
    },
    options.failing
      ? {
          errorClass: "ContainerExit",
          errorMessage: "the harness exited before it wrote a result",
          exitCode: 137,
          kind: "failed",
        }
      : {
          costUsd: CostUsd.make("1.24"),
          durationMs: 214_000,
          kind: "finished",
          outcome: "done",
          totalTokens: 51_400,
          turns: 9,
        },
  ] as const satisfies readonly RunEventPayload[];

/**
 * Writes one run's events, spaced a minute apart so the timeline has a shape
 * rather than a single instant with eight rows in it.
 */
const writeEvents = (options: {
  readonly events: readonly RunEventPayload[];
  readonly runId: RunId;
  readonly taskId: Task["id"];
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const runEvents = yield* RunEventRepo;
    const now = yield* DateTime.now;
    yield* Effect.forEach(options.events, (payload, seq) =>
      runEvents.append({
        occurredAt: DateTime.subtractDuration(
          now,
          Duration.minutes(options.events.length - seq)
        ),
        payload,
        runId: options.runId,
        seq,
        subject: { id: options.taskId, kind: "task" },
        workspaceId: options.workspaceId,
      })
    );
  });

/** Opens a session and an attempt on one task, as the orchestrator does. */
const openAttempt = (options: {
  readonly taskId: Task["id"];
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    const sessions = yield* AgentSessionRepo;
    const subject = { id: options.taskId, kind: "task" } as const;

    const session = yield* sessions.open({
      provider: "claude",
      subject,
      workspaceId: options.workspaceId,
    });
    const run = yield* runs.create({
      agentSessionId: session.id,
      provider: "claude",
      subject,
      trigger: "status_change",
      workspaceId: options.workspaceId,
    });
    yield* runs.attachContainer({
      containerId: `atm-${run.id}-demo0000`,
      id: run.id,
      workspaceId: options.workspaceId,
    });
    yield* runs.start({
      id: run.id,
      model: "claude-opus-5",
      sandboxImage: "atm-base:arm64",
      workspaceId: options.workspaceId,
    });
    return { run, session };
  });

/**
 * The card that is genuinely being worked on: a live run, a session that is
 * still open, and a timeline that stops mid-turn. Nothing closes it, because
 * the loop is not running — which is exactly the state a spinner draws.
 */
const liveAttempt = (options: {
  readonly taskId: Task["id"];
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const { run } = yield* openAttempt(options);
    yield* writeEvents({
      events: workerEvents().slice(0, EVENTS_BEFORE_LIVE),
      runId: run.id,
      taskId: options.taskId,
      workspaceId: options.workspaceId,
    });
  });

/** An attempt that ran to a clean finish, with the message a worker leaves behind. */
const finishedAttempt = (options: {
  readonly taskId: Task["id"];
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const messages = yield* TaskMessageRepo;
    const runs = yield* RunRepo;
    const sessions = yield* AgentSessionRepo;

    const { run, session } = yield* openAttempt(options);
    yield* writeEvents({
      events: workerEvents(),
      runId: run.id,
      taskId: options.taskId,
      workspaceId: options.workspaceId,
    });
    yield* runs.close({
      branch: "atm/demo-branch",
      costUsd: CostUsd.make("1.24"),
      durationMs: 214_000,
      id: run.id,
      outcome: "done",
      totalTokens: 51_400,
      turns: 9,
      workspaceId: options.workspaceId,
    });
    yield* sessions.finish({
      id: session.id,
      workspaceId: options.workspaceId,
    });
    yield* messages.post({
      author: { kind: "agent", runId: run.id, sessionId: session.id },
      body: "Pushed `atm/demo-branch` and opened the pull request. The error copy is in one place now, so a new field inherits it.",
      taskId: options.taskId,
      workspaceId: options.workspaceId,
    });
    yield* messages.post({
      author: { kind: "agent", runId: run.id, sessionId: session.id },
      body: "Done. Tests pass locally.",
      kind: "fallback",
      taskId: options.taskId,
      workspaceId: options.workspaceId,
    });
    return { session };
  });

/** An attempt that crashed, and the epitaph the orchestrator writes for it. */
const failedAttempt = (options: {
  readonly taskId: Task["id"];
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const messages = yield* TaskMessageRepo;
    const runs = yield* RunRepo;
    const sessions = yield* AgentSessionRepo;

    const { run, session } = yield* openAttempt(options);
    yield* writeEvents({
      events: workerEvents({ failing: true }),
      runId: run.id,
      taskId: options.taskId,
      workspaceId: options.workspaceId,
    });
    yield* runs.close({
      errorClass: "ContainerExit",
      errorMessage: "the harness exited before it wrote a result",
      exitCode: 137,
      id: run.id,
      outcome: "errored",
      workspaceId: options.workspaceId,
    });
    yield* sessions.fail({
      errorMessage: "the harness exited before it wrote a result",
      id: session.id,
      workspaceId: options.workspaceId,
    });
    yield* messages.post({
      author: { kind: "orchestrator", runId: run.id },
      body: "The run exited 137 before writing a result. Container out of memory during the install step.",
      kind: "run_error",
      taskId: options.taskId,
      workspaceId: options.workspaceId,
    });
  });

/** Two conversations, so the chat overlay has a list rather than one thread. */
const chats = (options: {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const messages = yield* ChatMessageRepo;
    const threads = yield* ChatThreadRepo;

    const conversations = [
      {
        title: "Theme pass",
        turns: [
          {
            body: "Where did the dark theme work end up?",
            role: "user",
          },
          {
            body: "It is in progress on the website project, with a run open on it now. Nothing is in review yet.",
            role: "manager",
          },
          { body: "File the icon migration behind it.", role: "user" },
          {
            body: "Filed. It is in progress and parked for two hours after three failed attempts.",
            role: "manager",
          },
        ],
      },
      {
        title: "Push notifications",
        turns: [
          { body: "Why did the push registration run fail?", role: "user" },
          {
            body: "The container exited 137 during install — out of memory. The task is back in review with the error on it.",
            role: "manager",
          },
        ],
      },
    ] as const;

    yield* Effect.forEach(conversations, (conversation) =>
      Effect.gen(function* () {
        const thread = yield* threads.open({
          provider: "claude",
          title: conversation.title,
          userId: options.userId,
          workspaceId: options.workspaceId,
        });
        yield* Effect.forEach(conversation.turns, (turn) =>
          messages.append({
            body: turn.body,
            intakeKind: turn.role === "user" ? "api" : null,
            role: turn.role,
            threadId: thread.id,
            workspaceId: options.workspaceId,
          })
        );
      })
    );
  });

const seedDemo = Effect.gen(function* () {
  const { owner, workspace } = yield* ensureWorkspace();
  const workspaceId = workspace.id;

  const projects = yield* ProjectRepo;
  const tasks = yield* TaskRepo;

  const stored = yield* projects.list({ workspaceId });
  if (stored.some((project) => project.name === MARKER_PROJECT)) {
    yield* Effect.logInfo(
      `${MARKER_PROJECT} is already here — the demo board is seeded, nothing to write`
    );
    return;
  }

  const written = yield* Effect.forEach(projectsOf(workspaceId), (input) =>
    projects.create(input)
  );
  const [website, mobile] = written;
  if (website === undefined || mobile === undefined) {
    return yield* Effect.die(new Error("the demo projects were not written"));
  }

  const board = yield* Effect.forEach(
    tasksOf({ mobile: mobile.id, website: website.id, workspaceId }),
    (input) => tasks.create(input)
  );
  yield* Effect.logInfo(
    `${written.length} projects, ${board.length} tasks across every column`
  );

  const asOrchestrator = withActor(
    Actor.cases.orchestrator.make({ loopInstance: LOOP_INSTANCE })
  );
  const asHuman = withActor(Actor.cases.human.make({ userId: owner }));

  const live = taskNamed(board, "Dark theme pass");
  yield* asOrchestrator(liveAttempt({ taskId: live.id, workspaceId }));

  const reviewed = taskNamed(board, "Sign-in page states");
  const { session } = yield* asOrchestrator(
    finishedAttempt({ taskId: reviewed.id, workspaceId })
  );

  const crashed = taskNamed(board, "Push notification registration");
  yield* asOrchestrator(failedAttempt({ taskId: crashed.id, workspaceId }));

  // The park stamp is what the card reads to draw its badge, and it is set by
  // the dispatcher rather than at creation — so it is a patch, made as the
  // person who would have been watching it fail.
  const parked = taskNamed(board, "Migrate the icon set");
  const parkedUntil = yield* DateTime.now;
  yield* asHuman(
    tasks.update({
      fields: { parkedUntil: DateTime.addDuration(parkedUntil, PARK_AHEAD) },
      id: parked.id,
      workspaceId,
    })
  );

  yield* asHuman(
    Effect.gen(function* () {
      const messages = yield* TaskMessageRepo;
      yield* messages.post({
        author: { kind: "human", userId: owner },
        body: "Read the PR. The empty state still shows the spinner for a beat — worth a look before this merges.",
        taskId: reviewed.id,
        workspaceId,
      });
    })
  );

  yield* chats({ userId: owner, workspaceId });

  yield* Effect.logInfo(
    `live run on "${live.title}", a finished one on "${reviewed.title}" (session ${session.id}), a crash on "${crashed.title}", and "${parked.title}" parked`
  );
});

BunRuntime.runMain(
  seedDemo.pipe(
    withActor(SEEDER),
    Effect.provide(storeLayer({ applicationName: APPLICATION_NAME }))
  )
);
