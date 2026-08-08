import {
  CheckmarkCircle02Icon,
  FolderOpenIcon,
  Note01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Proposal } from "@workspace/api";
import type { TaskId } from "@workspace/domain";
import { fileScopeAddressOf } from "@workspace/domain";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@workspace/ui/components/alert-dialog";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { CodeBlock } from "@workspace/ui/components/markdown";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useCallback } from "react";
import { type ScopeFileRef, scopeFileQuery } from "@/api/files";
import {
  proposalsQuery,
  proposalTargetOf,
  useConfirmProposal,
  useRejectProposal,
} from "@/api/proposals";
import { EmptyState } from "@/components/empty-state";
import { Failed, failureSentence, Pending } from "@/components/query-state";
import { formatBytes, formatRelative } from "@/lib/format";
import {
  BUDGET_SENTENCES,
  budgetPressureOf,
  byteLengthOf,
  isInstructionFile,
} from "@/lib/instruction-budget";
import { scopePathOf } from "@/lib/scope-path";

/** How each state reads, and how loud it is drawn. */
const STATE_FACES = {
  accepted: { label: "accepted", variant: "secondary" },
  pending: { label: "waiting for you", variant: "default" },
  rejected: { label: "refused", variant: "outline" },
} as const;

/** Whether a failure is the endpoint saying there is nothing there yet. */
const isMissing = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "NotFound";

/**
 * What is at that path in the target directory right now.
 *
 * Beside the proposed text rather than instead of it, because accepting is a
 * replacement: the one question a person deciding has is what they are losing,
 * and a panel that showed only the new bytes would answer it with nothing. A
 * path with no file yet is the ordinary case and says so — it is not a failure
 * to explain away.
 */
const CurrentFile = ({ at }: { readonly at: ScopeFileRef }) => {
  const file = useQuery(scopeFileQuery(at));

  if (file.isPending) {
    return <Skeleton className="m-3 h-24" />;
  }

  if (isMissing(file.error)) {
    return (
      <p className="p-3 text-muted-foreground text-xs">
        Nothing is at that path yet. Accepting creates it.
      </p>
    );
  }

  if (file.isError) {
    return (
      <p className="p-3 text-destructive text-xs">
        {failureSentence(file.error)}
      </p>
    );
  }

  if (file.data.encoding === "base64") {
    return (
      <p className="p-3 text-muted-foreground text-xs">
        The file there is not text — {formatBytes(file.data.bytes)} of something
        else.
      </p>
    );
  }

  return (
    <CodeBlock
      className="[&_pre]:max-h-80 [&_pre]:rounded-none [&_pre]:border-0"
      code={file.data.content}
      lang="markdown"
    />
  );
};

/**
 * The same, for a proposal whose target this app can name.
 *
 * A proposal's path and a file route's path are branded off the same rule and
 * are not the same type, so the decode is the check: a row naming a project
 * that is not on it, or a path the routes would refuse, has no directory to
 * read and says so rather than reading the wrong one.
 */
const CurrentContent = ({ proposal }: { readonly proposal: Proposal }) => {
  const scope = proposalTargetOf(proposal);
  const path = scopePathOf(proposal.path);

  if (scope === null || path === null) {
    return (
      <p className="p-3 text-muted-foreground text-xs">
        This proposal names a directory that cannot be resolved, so what is
        there now cannot be shown.
      </p>
    );
  }

  return <CurrentFile at={{ path, scope }} />;
};

interface CardProps {
  readonly proposal: Proposal;
}

/**
 * One request, and the two answers to it.
 *
 * Confirming writes the recorded bytes — what is on screen — rather than
 * re-reading the file the run left in its own folder. That folder is writable by
 * later runs on the same task, so re-reading would let a run change what
 * somebody is accepting in the window between reading it and clicking.
 */
const ProposalCard = ({ proposal }: CardProps) => {
  const confirm = useConfirmProposal();
  const reject = useRejectProposal();
  const target = proposalTargetOf(proposal);
  const path = scopePathOf(proposal.path);

  const { mutate: accept } = confirm;
  const { mutate: refuse } = reject;

  const onAccept = useCallback(
    () => accept({ proposalId: proposal.id, taskId: proposal.taskId }),
    [accept, proposal.id, proposal.taskId]
  );
  const onRefuse = useCallback(
    () => refuse({ proposalId: proposal.id, taskId: proposal.taskId }),
    [refuse, proposal.id, proposal.taskId]
  );

  const face = STATE_FACES[proposal.state];
  const pending = proposal.state === "pending";
  const failed = failureSentence(confirm.error ?? reject.error);
  const bytes = byteLengthOf(proposal.body);
  const instruction = isInstructionFile(proposal.path);

  return (
    <article className="flex flex-col gap-3 rounded-lg border p-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p
            className="truncate font-medium font-mono text-sm"
            title={proposal.path}
          >
            {proposal.scope}/{proposal.path}
          </p>
          <p className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
            <span>raised {formatRelative(proposal.createdAt)}</span>
            <span>{formatBytes(bytes)}</span>
            {proposal.decidedAt === null ? null : (
              <span>answered {formatRelative(proposal.decidedAt)}</span>
            )}
          </p>
        </div>
        <Badge variant={face.variant}>{face.label}</Badge>
      </header>

      {instruction ? (
        <p className="text-muted-foreground text-xs">
          {BUDGET_SENTENCES[budgetPressureOf(bytes)]}
        </p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="min-w-0 overflow-hidden rounded-md border">
          <p className="border-b bg-muted/30 px-3 py-1.5 text-muted-foreground text-xs">
            On disk now
          </p>
          <div className="overflow-auto">
            <CurrentContent proposal={proposal} />
          </div>
        </div>
        <div className="min-w-0 overflow-hidden rounded-md border">
          <p className="border-b bg-muted/30 px-3 py-1.5 text-muted-foreground text-xs">
            Proposed
          </p>
          <div className="overflow-auto">
            <CodeBlock
              className="[&_pre]:max-h-80 [&_pre]:rounded-none [&_pre]:border-0"
              code={proposal.body}
              lang="markdown"
            />
          </div>
        </div>
      </div>

      {failed === null ? null : (
        <p className="text-destructive text-xs">{failed}</p>
      )}

      <footer className="flex flex-wrap items-center gap-2">
        {target === null || path === null ? null : (
          <Button
            nativeButton={false}
            render={
              <Link
                search={{ path, scope: fileScopeAddressOf(target) }}
                to="/files"
              />
            }
            size="sm"
            variant="ghost"
          >
            <HugeiconsIcon icon={FolderOpenIcon} strokeWidth={2} />
            Open the directory
          </Button>
        )}

        {pending ? (
          <>
            <AlertDialog>
              <AlertDialogTrigger
                render={<Button disabled={confirm.isPending} size="sm" />}
              >
                <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2} />
                Accept
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Write this into {proposal.scope}?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    The bytes above are written to “{proposal.path}”, replacing
                    whatever is there. Every later run on{" "}
                    {proposal.scope === "workspace"
                      ? "every project"
                      : "this project"}{" "}
                    is given the result. The scope's git history keeps what was
                    there before.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={onAccept}>
                    Accept
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Button
              disabled={reject.isPending}
              onClick={onRefuse}
              size="sm"
              variant="outline"
            >
              Refuse
            </Button>
          </>
        ) : null}
      </footer>
    </article>
  );
};

/**
 * Waiting ones first, whatever their age, and each group in the order the
 * endpoint answered.
 *
 * A decided proposal is a record; a pending one is a run's request that nothing
 * else in the system will resolve — so a week-old request must not sit below
 * this morning's answered one, where a reader who scrolls the first screen
 * never sees it.
 */
export const pendingFirst = (proposals: readonly Proposal[]) => [
  ...proposals.filter((proposal) => proposal.state === "pending"),
  ...proposals.filter((proposal) => proposal.state !== "pending"),
];

interface TaskProposalsProps {
  readonly taskId: TaskId;
}

/**
 * What this task's runs asked a person to change above their own folder.
 *
 * A worker's workspace scope is a read-only mount, because a run that has
 * cloned an untrusted repository must not be able to edit the rules every later
 * run is given. This panel is what that flag leaves open: the run writes a file
 * in the one directory it owns, the loop records it inert, and a person answers
 * it here. Until this existed the only answer was an HTTP call by hand.
 *
 * Waiting ones first regardless of age. A decided proposal is a record; a
 * pending one is a run's request that nothing else will resolve.
 */
export const TaskProposals = ({ taskId }: TaskProposalsProps) => {
  const proposals = useQuery(proposalsQuery(taskId));

  if (proposals.isPending) {
    return <Pending label="Loading proposals" lines={3} />;
  }

  if (proposals.isError) {
    return (
      <Failed
        error={proposals.error}
        onRetry={proposals.refetch}
        title="Proposals did not load"
      />
    );
  }

  if (proposals.data.length === 0) {
    return (
      <EmptyState
        description="A run on this task has asked for nothing outside its own folder. When one does, what it wants written shows up here for you to accept or refuse."
        icon={Note01Icon}
        title="Nothing to decide"
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {pendingFirst(proposals.data).map((proposal) => (
        <ProposalCard key={proposal.id} proposal={proposal} />
      ))}
    </div>
  );
};
