import { useQuery } from "@tanstack/react-query";
import type { AgentSession, Task } from "@workspace/api";
import {
  type NextSession,
  nextSessionOf,
  type SessionStatus,
} from "@workspace/domain";
import { useCallback, useMemo } from "react";
import { sessionsQuery } from "@/api/sessions";
import { useSelectNextSession } from "@/api/tasks";
import {
  type PropertyOption,
  PropertySelect,
} from "@/features/task/property-select";
import { formatRelative } from "@/lib/format";

/** Enough of a session id to recognise it beside a comment that names it. */
const ID_PREFIX = 8;

/** Where the named sessions sit, under the two choices that are not one session. */
const RESUME_GROUP = "Resume a session";

/** How a session's own state is coloured, on the same principle the columns are. */
const SESSION_TONES = {
  failed: "bg-destructive",
  finished: "bg-emerald-500",
  running: "bg-sky-500",
} as const satisfies Record<SessionStatus, string>;

/** One choice in the next-session list, and the value it writes to the task. */
interface SessionChoice extends PropertyOption<string> {
  readonly next: NextSession;
}

/** What a session says about itself in one line beside its name. */
const hintFor = (session: AgentSession) =>
  session.endedAt === null
    ? `${session.status} · started ${formatRelative(session.createdAt)}`
    : `${session.status} · ended ${formatRelative(session.endedAt)}`;

const choicesFor = (sessions: readonly AgentSession[]): SessionChoice[] => [
  {
    label: "Continue the latest session",
    next: { mode: "latest" },
    value: "latest",
  },
  { label: "Start a fresh session", next: { mode: "new" }, value: "new" },
  ...sessions.map((session) => ({
    group: RESUME_GROUP,
    hint: hintFor(session),
    label: `${session.provider} ${session.id.slice(0, ID_PREFIX)}`,
    next: { mode: "specific", sessionId: session.id } as const,
    tone: SESSION_TONES[session.status],
    value: session.id as string,
  })),
];

/** Which choice the task's two columns currently amount to. */
const selectedValue = (next: NextSession): string =>
  next.mode === "specific" ? next.sessionId : next.mode;

/**
 * The task's choice, always in the list.
 *
 * A task can name a session the list has not arrived with — while the sessions
 * are still loading, or after one was removed — and a control that answers that
 * with its placeholder says the task has no choice when it has one. The id
 * stands in for the session until something better is known.
 */
const withSelected = (
  choices: readonly SessionChoice[],
  value: string
): readonly SessionChoice[] =>
  choices.some((choice) => choice.value === value)
    ? choices
    : [
        ...choices,
        {
          group: RESUME_GROUP,
          label: `Session ${value.slice(0, ID_PREFIX)}`,
          next: {
            mode: "specific",
            sessionId: value as AgentSession["id"],
          } as const,
          value,
        },
      ];

/**
 * Which session the next run continues.
 *
 * The selection lives on the task rather than on the button that starts a run,
 * so a choice made here and a sentence said to the manager write the same
 * value. The orchestrator honours it once and puts it back to the default,
 * which is why the control re-reads the task instead of remembering.
 *
 * Drawn as one of the task's properties, beside status and project: it is a
 * fact about what the task does next, not one of the sessions it lists. The
 * sessions themselves sit under their own heading in the list, each with what
 * it did and when it stopped — resuming the wrong conversation is the mistake
 * this control exists to prevent, and eight characters of id cannot prevent it.
 */
export const NextSessionSelect = ({ task }: { readonly task: Task }) => {
  const sessions = useQuery(sessionsQuery(task.id));
  const select = useSelectNextSession();
  const { mutate } = select;

  const selected = selectedValue(nextSessionOf(task));
  const choices = useMemo(
    () => withSelected(choicesFor(sessions.data ?? []), selected),
    [selected, sessions.data]
  );

  const onChange = useCallback(
    (value: string) => {
      const choice = choices.find((candidate) => candidate.value === value);
      if (choice !== undefined) {
        mutate({ next: choice.next, taskId: task.id });
      }
    },
    [choices, mutate, task.id]
  );

  return (
    <PropertySelect
      ariaLabel="Session the next run continues"
      disabled={select.isPending}
      items={choices}
      onChange={onChange}
      value={selected}
    />
  );
};
