import { BubbleChatIcon, FileBlockIcon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import type { AgentSession, Task } from "@workspace/api";
import type { TaskId } from "@workspace/domain";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible";
import { sessionsQuery, useTranscript } from "@/api/sessions";
import { EmptyState } from "@/components/empty-state";
import { Pending } from "@/components/query-state";
import { formatRelative } from "@/lib/format";

/** Enough of a session id to recognise it beside a comment that names it. */
const ID_PREFIX = 8;

/**
 * The agent conversations behind a task.
 *
 * A task collects several sessions over its life — the one that wrote the code,
 * the fresh one that reviewed work it had not seen, the first one resuming with
 * that review as its prompt — so the list is the history of who was thinking.
 * Which of them the next run continues is a property of the task, set with the
 * other properties at the top.
 */
export const TaskSessions = ({ task }: { readonly task: Task }) => {
  const sessions = useQuery(sessionsQuery(task.id));

  if (sessions.isPending) {
    return <Pending label="Loading sessions" lines={3} />;
  }

  if (sessions.data === undefined || sessions.data.length === 0) {
    return (
      <EmptyState
        description="The first run on this task opens one."
        icon={BubbleChatIcon}
        title="No sessions yet"
      />
    );
  }

  return (
    <ol className="flex flex-col gap-2">
      {sessions.data.map((session) => (
        <SessionRow key={session.id} session={session} taskId={task.id} />
      ))}
    </ol>
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
  <li className="flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-xs">
    <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
      <span className="font-medium text-foreground text-sm">
        {session.provider}
      </span>
      <Badge variant={session.status === "failed" ? "destructive" : "outline"}>
        {session.status}
      </Badge>
      <span className="font-mono" title={session.id}>
        {session.id.slice(0, ID_PREFIX)}
      </span>
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
      <CollapsibleTrigger
        render={
          <Button
            className="-ml-2 text-muted-foreground"
            size="xs"
            variant="ghost"
          />
        }
      >
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
      <EmptyState
        description="This deployment does not serve session transcripts. The run timeline carries what the run did in the meantime."
        icon={FileBlockIcon}
        title="Transcripts are not available yet"
      />
    );
  }
  if (query.isPending) {
    return <Pending label="Loading transcript" lines={3} />;
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
