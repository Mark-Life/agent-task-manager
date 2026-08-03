import { useQuery } from "@tanstack/react-query";
import type { Run } from "@workspace/api";
import { isRunLive, type RunId, type TaskId } from "@workspace/domain";
import { Badge } from "@workspace/ui/components/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import { Item, ItemContent } from "@workspace/ui/components/item";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Spinner } from "@workspace/ui/components/spinner";
import { useCallback } from "react";
import { runsQuery } from "@/api/runs";
import {
  formatCost,
  formatDuration,
  formatRelative,
  formatTokens,
} from "@/lib/format";

/** How often the list re-reads itself while an attempt is still running. */
const LIVE_POLL_MS = 5000;

interface TaskRunsProps {
  readonly onSelectRun: (runId: RunId) => void;
  readonly selectedRunId?: RunId;
  readonly taskId: TaskId;
}

/**
 * Which attempt a timeline should be showing: the one asked for, and otherwise
 * the newest.
 *
 * The list arrives newest first, so the head of it is the live run whenever
 * there is one — which is what somebody opening a link to a working task wants
 * on screen without choosing anything. Undefined means the task has no attempts
 * yet, and the timeline is not drawn at all.
 */
export const useCurrentRun = (taskId: TaskId, chosen?: RunId) => {
  const runs = useQuery(runsQuery(taskId));
  return chosen ?? runs.data?.[0]?.id;
};

/**
 * Every attempt at the task, newest first, with what each one cost.
 *
 * The economics are nullable end to end and are rendered as nothing when they
 * are absent — a run that fell over did not cost nothing and did not take no
 * time, it produced no measurement, and a printed `$0` is a number somebody
 * later adds up. Selecting a row is how the timeline below learns which attempt
 * to read. The list re-reads itself only while an attempt is live, because the
 * duration, the tokens and the cost are written when that attempt ends.
 */
export const TaskRuns = ({
  onSelectRun,
  selectedRunId,
  taskId,
}: TaskRunsProps) => {
  const runs = useQuery({
    ...runsQuery(taskId),
    refetchInterval: (query) =>
      query.state.data?.some(isRunLive) === true ? LIVE_POLL_MS : false,
  });

  if (runs.isPending) {
    return <Skeleton className="h-16 w-full" />;
  }
  if (runs.data === undefined || runs.data.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No attempts yet</EmptyTitle>
          <EmptyDescription>
            Moving this task into progress is what starts one.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {runs.data.map((run) => (
        <RunRow
          key={run.id}
          onSelect={onSelectRun}
          run={run}
          selected={run.id === selectedRunId}
        />
      ))}
    </ul>
  );
};

interface RunRowProps {
  readonly onSelect: (runId: RunId) => void;
  readonly run: Run;
  readonly selected: boolean;
}

/**
 * One attempt, dense: what it was, how it ended, and the three numbers worth
 * comparing between attempts. The row is a button because choosing an attempt
 * is the only thing it does, and the failure text sits under it rather than
 * behind a click — a crash is the reason anyone opened this list.
 */
const RunRow = ({ onSelect, run, selected }: RunRowProps) => {
  const select = useCallback(() => onSelect(run.id), [onSelect, run.id]);
  const live = isRunLive(run);
  const duration = formatDuration(run.durationMs);
  const tokens = formatTokens(run.totalTokens);
  const cost = formatCost(run.costUsd);

  return (
    <li>
      <Item
        onClick={select}
        render={<button type="button" />}
        size="sm"
        variant={selected ? "muted" : "default"}
      >
        <ItemContent className="gap-1.5">
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
            <span className="font-medium text-foreground">
              Attempt {run.attempt}
            </span>
            <Badge
              variant={run.status === "failed" ? "destructive" : "outline"}
            >
              {run.status}
            </Badge>
            {live ? <Spinner className="size-3" /> : null}
            <span>{run.trigger}</span>
            {run.model === null ? null : <span>{run.model}</span>}
            <span>{formatRelative(run.startedAt ?? run.createdAt)}</span>
            {duration === null ? null : <span>{duration}</span>}
            {tokens === null ? null : <span>{tokens} tokens</span>}
            {cost === null ? null : (
              <span className="text-foreground">{cost}</span>
            )}
          </div>
          {run.errorMessage === null ? null : (
            <p className="whitespace-pre-wrap text-destructive text-xs">
              {run.errorClass === null ? null : `${run.errorClass}: `}
              {run.errorMessage}
            </p>
          )}
        </ItemContent>
      </Item>
    </li>
  );
};
