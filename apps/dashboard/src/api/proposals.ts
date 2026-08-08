import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Proposal } from "@workspace/api";
import {
  type FileScope,
  fileScopeAddressOf,
  type ProposalId,
  type TaskId,
} from "@workspace/domain";
import { keys } from "@/api/keys";
import { apiMutation, apiQuery } from "@/api/query";

/** One proposal, and the task it was raised on. Both, because the routes are nested under the task. */
export interface ProposalRef {
  readonly proposalId: ProposalId;
  readonly taskId: TaskId;
}

/**
 * A task's proposals, newest first, decided ones included.
 *
 * The body travels on the row rather than behind a second read, so a page of
 * three proposals is one request and a person deciding can see what they are
 * accepting without opening anything.
 */
export const proposalsQuery = (taskId: TaskId) =>
  apiQuery(keys.proposals(taskId), (client) =>
    client.proposals.list({ params: { taskId } })
  );

/**
 * Which directory of the tree a proposal is about, in the words the file routes
 * use. Null for a project proposal carrying no project, which is a row that
 * cannot be pointed at a directory — the panel says so rather than guessing at
 * one.
 */
export const proposalTargetOf = (proposal: Proposal): FileScope | null => {
  if (proposal.scope === "workspace") {
    return { scope: "workspace" };
  }
  return proposal.projectId === null
    ? null
    : { projectId: proposal.projectId, scope: "project" };
};

/**
 * The panel that shows the current file beside the proposed one is reading the
 * target scope, so accepting has to refresh that scope as well as the list —
 * otherwise the "on disk now" column keeps showing what was there before the
 * bytes a person just accepted.
 */
const refreshDecided = (
  queryClient: ReturnType<typeof useQueryClient>,
  proposal: Proposal
) => {
  const target = proposalTargetOf(proposal);
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: keys.proposals(proposal.taskId),
    }),
    target === null
      ? Promise.resolve()
      : queryClient.invalidateQueries({
          queryKey: keys.scope(fileScopeAddressOf(target)),
        }),
  ]);
};

/**
 * Accept it: the recorded bytes are written into the scope the proposal names,
 * and the person who chose is recorded on the row.
 *
 * What lands is what the run proposed and what this screen showed, never the
 * file the run left in its own folder — a later run on the same task can
 * rewrite that folder, and re-reading it would let one change what somebody is
 * accepting between the moment they read it and the moment they click.
 */
export const useConfirmProposal = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((ref: ProposalRef, client) =>
      client.proposals.confirm({
        params: { proposalId: ref.proposalId, taskId: ref.taskId },
        payload: {},
      })
    ),
    onSuccess: (proposal) => refreshDecided(queryClient, proposal),
  });
};

/**
 * Refuse it. Nothing is written anywhere, and the row keeps the refusal so a
 * resumed session can find out that what it asked for last time was turned
 * down.
 */
export const useRejectProposal = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((ref: ProposalRef, client) =>
      client.proposals.reject({
        params: { proposalId: ref.proposalId, taskId: ref.taskId },
        payload: {},
      })
    ),
    onSuccess: (proposal) =>
      queryClient.invalidateQueries({
        queryKey: keys.proposals(proposal.taskId),
      }),
  });
};
