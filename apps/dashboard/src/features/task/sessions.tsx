import {
  BubbleChatIcon,
  FileBlockIcon,
  Robot01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { AgentSession, AgentSessionUsage, Task } from "@workspace/api";
import type { TaskId } from "@workspace/domain";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@workspace/ui/components/item";
import {
  sessionsQuery,
  sessionsUsageQuery,
  useTranscript,
} from "@/api/sessions";
import { EmptyState } from "@/components/empty-state";
import { Pending } from "@/components/query-state";
import { SessionUsagePanel } from "@/features/task/session-usage";
import { formatRelative } from "@/lib/format";

/** Enough of a session id to recognise it beside a message that names it. */
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
  // One request for every row's figures. A session absent from the answer has
  // nothing recorded, which the row says in words rather than as a zero.
  const usage = useQuery(sessionsUsageQuery(task.id));
  const usageBySession = new Map(
    (usage.data ?? []).map((row) => [row.sessionId, row])
  );

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
    <ItemGroup className="gap-1">
      {sessions.data.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          taskId={task.id}
          usage={usageBySession.get(session.id)}
        />
      ))}
    </ItemGroup>
  );
};

interface SessionRowProps {
  readonly session: AgentSession;
  readonly taskId: TaskId;
  /** Absent until a run on this session has finished and left figures. */
  readonly usage: AgentSessionUsage | undefined;
}

/**
 * One session: what it is talking to, whether it can still be resumed, why it
 * stopped if it failed, and how much of its context window it is holding. A
 * failed session stays in the list because it is part of what happened on the
 * task — hiding it would leave a gap between two runs that a reader cannot
 * account for.
 *
 * The window figure is on the row rather than behind the disclosure because it
 * is the one that changes what a person does next: a session near the end of
 * its window is one to stop and continue in a fresh one, and that decision is
 * made while scanning the list.
 */
const SessionRow = ({ session, taskId, usage }: SessionRowProps) => (
  <Collapsible className="rounded-md border border-border">
    <Item size="sm">
      <ItemMedia variant="icon">
        <HugeiconsIcon icon={Robot01Icon} strokeWidth={2} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex-wrap gap-2 text-muted-foreground">
          <span className="font-medium text-foreground">
            {session.provider}
          </span>
          <Badge
            variant={session.status === "failed" ? "destructive" : "outline"}
          >
            {session.status}
          </Badge>
          <span className="font-mono text-[0.625rem]" title={session.id}>
            {session.id.slice(0, ID_PREFIX)}
          </span>
          <span>started {formatRelative(session.createdAt)}</span>
          {session.endedAt === null ? null : (
            <span>ended {formatRelative(session.endedAt)}</span>
          )}
        </ItemTitle>
        {session.errorMessage === null ? null : (
          <ItemDescription className="line-clamp-none whitespace-pre-wrap text-destructive">
            {session.errorMessage}
          </ItemDescription>
        )}
        <SessionUsagePanel
          running={session.status === "running"}
          usage={usage}
        />
      </ItemContent>
      <ItemActions>
        <CollapsibleTrigger
          render={
            <Button
              className="text-muted-foreground"
              size="xs"
              variant="ghost"
            />
          }
        >
          Transcript
        </CollapsibleTrigger>
      </ItemActions>
    </Item>
    <CollapsibleContent className="px-3 pb-2.5">
      <SessionTranscript sessionId={session.id} taskId={taskId} />
    </CollapsibleContent>
  </Collapsible>
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
