import { useQuery } from "@tanstack/react-query";
import type { AgentSession, Task } from "@workspace/api";
import {
  type NextSession,
  nextSessionOf,
  type TaskId,
} from "@workspace/domain";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import { Label } from "@workspace/ui/components/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@workspace/ui/components/native-select";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { type ChangeEvent, useCallback, useMemo } from "react";
import { sessionsQuery, useTranscript } from "@/api/sessions";
import { useSelectNextSession } from "@/api/tasks";
import { formatRelative } from "@/lib/format";

/** Enough of a session id to recognise it beside a comment that names it. */
const ID_PREFIX = 8;

/** One choice in the next-session list, and the value it writes to the task. */
interface SessionChoice {
  readonly label: string;
  readonly next: NextSession;
  readonly value: string;
}

const choicesFor = (sessions: readonly AgentSession[]): SessionChoice[] => [
  {
    label: "Continue the latest session",
    next: { mode: "latest" },
    value: "latest",
  },
  { label: "Start a fresh session", next: { mode: "new" }, value: "new" },
  ...sessions.map((session) => ({
    label: `Resume ${session.provider} ${session.id.slice(0, ID_PREFIX)}`,
    next: { mode: "specific", sessionId: session.id } as const,
    value: session.id,
  })),
];

/** Which choice the task's two columns currently amount to. */
const selectedValue = (next: NextSession): string =>
  next.mode === "specific" ? next.sessionId : next.mode;

/**
 * The agent conversations behind a task, and which one the next run uses.
 *
 * A task collects several sessions over its life — the one that wrote the code,
 * the fresh one that reviewed work it had not seen, the first one resuming with
 * that review as its prompt — so the list is the history of who was thinking,
 * and the selector is the one lever over what happens next.
 */
export const TaskSessions = ({ task }: { readonly task: Task }) => {
  const sessions = useQuery(sessionsQuery(task.id));
  const choices = useMemo(
    () => choicesFor(sessions.data ?? []),
    [sessions.data]
  );

  return (
    <section className="flex flex-col gap-6">
      <NextSessionPicker choices={choices} task={task} />
      {sessions.isPending ? <Skeleton className="h-16 w-full" /> : null}
      {sessions.data?.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No sessions yet</EmptyTitle>
            <EmptyDescription>
              The first run on this task opens one.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      <ol className="flex flex-col gap-4">
        {sessions.data?.map((session) => (
          <SessionRow key={session.id} session={session} taskId={task.id} />
        ))}
      </ol>
    </section>
  );
};

interface PickerProps {
  readonly choices: readonly SessionChoice[];
  readonly task: Task;
}

/**
 * Which session the next run continues.
 *
 * The selection lives on the task rather than on the button that starts a run,
 * so a choice made here and a sentence said to the manager write the same
 * value. The orchestrator honours it once and puts it back to the default,
 * which is why the control re-reads the task instead of remembering.
 */
const NextSessionPicker = ({ choices, task }: PickerProps) => {
  const select = useSelectNextSession();
  const { mutate } = select;

  const onChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const choice = choices.find(
        (candidate) => candidate.value === event.target.value
      );
      if (choice !== undefined) {
        mutate({ next: choice.next, taskId: task.id });
      }
    },
    [choices, mutate, task.id]
  );

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="next-session">Next run</Label>
      <NativeSelect
        className="w-full max-w-sm"
        disabled={select.isPending}
        id="next-session"
        onChange={onChange}
        value={selectedValue(nextSessionOf(task))}
      >
        {choices.map((choice) => (
          <NativeSelectOption key={choice.value} value={choice.value}>
            {choice.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <p className="text-muted-foreground text-xs">
        Spent by the run it chooses, then back to continuing the latest.
      </p>
    </div>
  );
};

interface SessionRowProps {
  readonly session: AgentSession;
  readonly taskId: TaskId;
}

/**
 * One session: what it is talking to, whether it can still be resumed, and why
 * it stopped if it failed. A failed session stays in the list because it is
 * part of what happened on the task — hiding it would leave a gap between two
 * runs that a reader cannot account for.
 */
const SessionRow = ({ session, taskId }: SessionRowProps) => (
  <li className="flex flex-col gap-1.5 text-xs">
    <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
      <Badge variant={session.status === "failed" ? "destructive" : "outline"}>
        {session.status}
      </Badge>
      <span className="font-medium text-foreground">{session.provider}</span>
      <span title={session.id}>{session.id.slice(0, ID_PREFIX)}</span>
      <span>started {formatRelative(session.createdAt)}</span>
      {session.endedAt === null ? null : (
        <span>ended {formatRelative(session.endedAt)}</span>
      )}
    </div>
    {session.errorMessage === null ? null : (
      <p className="whitespace-pre-wrap text-destructive">
        {session.errorMessage}
      </p>
    )}
    <Collapsible>
      <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
        Transcript
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <SessionTranscript sessionId={session.id} taskId={taskId} />
      </CollapsibleContent>
    </Collapsible>
  </li>
);

interface TranscriptProps {
  readonly sessionId: AgentSession["id"];
  readonly taskId: TaskId;
}

/**
 * What the model was told and what it said back — when a deployment can answer
 * it.
 *
 * Reading a transcript means reading the file the provider wrote, and the
 * gateway does not have that dependency yet: it answers 501, which is a fact
 * about the deployment rather than a fault the reader can retry. So the panel
 * says exactly that and points at the run timeline, which is the full record
 * that does exist. Nothing is invented in the meantime.
 */
const SessionTranscript = ({ sessionId, taskId }: TranscriptProps) => {
  const { query, unavailable } = useTranscript(taskId, sessionId);

  if (unavailable) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Transcripts are not available yet</EmptyTitle>
          <EmptyDescription>
            This deployment does not serve session transcripts. The run timeline
            carries what the run did in the meantime.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (query.isPending) {
    return <Skeleton className="h-16 w-full" />;
  }
  if (query.data === undefined) {
    return <p className="text-muted-foreground">Nothing to read.</p>;
  }

  return (
    <ol className="flex flex-col gap-2">
      {query.data.entries.map((entry, index) => (
        <li className="flex gap-2" key={`${entry.line}-${index}`}>
          <span className="w-20 shrink-0 text-muted-foreground">
            {entry.toolName ?? entry.role}
          </span>
          <span className="whitespace-pre-wrap">{entry.text}</span>
        </li>
      ))}
    </ol>
  );
};
