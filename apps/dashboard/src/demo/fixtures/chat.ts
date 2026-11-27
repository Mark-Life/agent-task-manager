/**
 * The manager conversation, and the human side of task threads.
 */

import type { TaskMessage, Thread, ThreadMessage } from "@workspace/api";
import {
  type ChatIntakeKind,
  ChatMessageId,
  type ChatMessageRole,
  TaskMessageId,
  ThreadId,
} from "@workspace/domain";
import {
  ago,
  DAY,
  DEMO_USER,
  DEMO_WORKSPACE,
  demoUuid,
  HOUR,
} from "@/demo/ids";
import { taskIdOf } from "./tasks";

export const THREAD = {
  current: ThreadId.make(demoUuid("thread", 1)),
  trip: ThreadId.make(demoUuid("thread", 2)),
} as const;

const thread = (
  id: ThreadId,
  title: string,
  age: number,
  isCurrent: boolean
): Thread => ({
  chatId: null,
  createdAt: ago(age),
  id,
  isCurrent,
  lastMessageAt: ago(isCurrent ? 2 : age / 2),
  provider: "claude",
  status: "active",
  title,
  updatedAt: ago(isCurrent ? 2 : age / 2),
  userId: DEMO_USER,
  workspaceId: DEMO_WORKSPACE,
});

export const THREADS: readonly Thread[] = [
  thread(THREAD.current, "Morning plan", 3 * HOUR, true),
  thread(THREAD.trip, "Lisbon trip", 4 * DAY, false),
];

interface Line {
  readonly body: string;
  readonly intake?: ChatIntakeKind;
  readonly minutes: number;
  readonly role: ChatMessageRole;
}

const MORNING: readonly Line[] = [
  {
    body: "What's on the board this morning? Anything stuck?",
    intake: "voice",
    minutes: 52,
    role: "user",
  },
  {
    body: "5 cards in progress, 4 with an agent on them right now. The Effect upgrade timed out last night after 60 minutes with 212 type errors left, so it is waiting for a slot.\n\nIn review: the sandbox egress PR (#83) and the booking form fix (#41) are both green. The contact page embed is still a draft.",
    minutes: 51,
    role: "manager",
  },
  {
    body: "Why is the Effect upgrade waiting?",
    intake: "voice",
    minutes: 44,
    role: "user",
  },
  {
    body: "Its last run hit the 60 minute limit with 212 type errors left. It starts again when a Codex slot is free, in about 20 minutes. I left a note on the card to go one package at a time, starting with `packages/domain`.",
    minutes: 43,
    role: "manager",
  },
  {
    body: "And for the clinic: the double booking bug, can it go before the SMS reminders?",
    minutes: 25,
    role: "user",
  },
  {
    body: "Yes. I moved it to in progress and ranked SMS reminders below it. Claude picked it up 22 minutes ago and already reproduced the bug in a test.",
    minutes: 24,
    role: "manager",
  },
  {
    body: "Good. Ping me when #83 needs me.",
    minutes: 3,
    role: "user",
  },
  {
    body: "Will do. I'll message you in Telegram when a check fails or a reviewer asks for changes.",
    minutes: 2,
    role: "manager",
  },
];

const TRIP: readonly Line[] = [
  {
    body: "Plan a week in Lisbon, 12 to 19 March. Flights from Zurich, somewhere quiet to stay.",
    intake: "voice",
    minutes: 4 * DAY,
    role: "user",
  },
  {
    body: "I made a lisbon-trip project with 5 cards: flights, where to stay, a hotel shortlist and two day plans. The flight price watch starts now.",
    minutes: 4 * DAY - 1,
    role: "manager",
  },
];

const messagesOf = (
  threadId: ThreadId,
  lines: readonly Line[],
  offset: number
): ThreadMessage[] =>
  lines.map((line, index) => ({
    body: line.body,
    createdAt: ago(line.minutes),
    forwardFrom: null,
    id: ChatMessageId.make(demoUuid("threadMessage", offset + index)),
    intakeKind: line.role === "user" ? (line.intake ?? "text") : null,
    role: line.role,
    runId: null,
    telegramChatId: null,
    telegramMessageId: null,
    threadId,
    transcriptChars: null,
    workspaceId: DEMO_WORKSPACE,
  }));

export const THREAD_MESSAGES: readonly ThreadMessage[] = [
  ...messagesOf(THREAD.current, MORNING, 1),
  ...messagesOf(THREAD.trip, TRIP, 100),
];

interface Note {
  readonly author: TaskMessage["authorKind"];
  readonly body: string;
  readonly minutes: number;
  readonly taskKey: string;
}

const NOTES: readonly Note[] = [
  {
    author: "human",
    body: "Use the OG card template, same paper colour. No gradients.",
    minutes: 13,
    taskKey: "covers",
  },
  {
    author: "manager",
    body: "Ranked above the SMS reminders on request. Fix it in the database.",
    minutes: 24,
    taskKey: "double-booking",
  },
  {
    author: "human",
    body: "Looks right. Can you add a test for the reconnect?",
    minutes: 30,
    taskKey: "sse",
  },
  {
    author: "orchestrator",
    body: "Run stopped at the 60 minute limit. Waiting for a free slot.",
    minutes: 4 * 60,
    taskKey: "effect-bump",
  },
];

export const HUMAN_MESSAGES: readonly TaskMessage[] = NOTES.map(
  (note, index) => ({
    agentSessionId: null,
    authorKind: note.author,
    authorUserId: note.author === "human" ? DEMO_USER : null,
    body: note.body,
    createdAt: ago(note.minutes),
    id: TaskMessageId.make(demoUuid("message", 500 + index)),
    kind: "message",
    runId: null,
    taskId: taskIdOf(note.taskKey),
    updatedAt: ago(note.minutes),
    workspaceId: DEMO_WORKSPACE,
  })
);
