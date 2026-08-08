/**
 * What a run asked a person to change in a directory it could not write, and
 * the two answers.
 *
 * **Confirming is admin-scoped, and that is the whole point of the group.** A
 * worker's workspace scope is a read-only mount so that a run which has read an
 * untrusted repository cannot edit the rules every later run is given. An agent
 * credential's ceiling is `task-write` and can never be issued higher, so an
 * admin scope here is the one way to say "a person, and only a person" in a
 * form the token machinery enforces rather than a form a handler remembers to
 * check. A manager confirming a worker's proposal would be the same run editing
 * the rules with one extra hop, which is why there is no tool for it either.
 *
 * Reading is ordinary. A run may list its own proposals, and should — that is
 * how a resumed session finds out that what it asked for last time was refused.
 */

import { ProposalId, TaskId } from "@workspace/domain";
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import { Forbidden, NotFound, ProposalAlreadyDecided } from "../errors";
import { Proposal } from "../schemas/proposal";
import { AdminAccess, ReadAccess } from "../security";

/** A task's proposals, newest first, decided ones included. */
const list = HttpApiEndpoint.get("list", "/tasks/:taskId/proposals", {
  error: NotFound,
  params: { taskId: TaskId },
  success: Schema.Array(Proposal),
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "List a task's proposals");

/**
 * Write the proposed body into the scope it names, and record that a person
 * chose to.
 *
 * The bytes are what was recorded, never what is on disk now: the file the run
 * wrote sits in a folder later runs on the same task can rewrite, so re-reading
 * it at this moment would let a run change what somebody is accepting after
 * they read it. What lands is recorded by the target scope's own git history,
 * which the next run's snapshot commits — there is no second trail here.
 */
const confirm = HttpApiEndpoint.post(
  "confirm",
  "/tasks/:taskId/proposals/:proposalId/confirm",
  {
    error: [Forbidden, NotFound, ProposalAlreadyDecided],
    params: { proposalId: ProposalId, taskId: TaskId },
    payload: Schema.Struct({}),
    success: Proposal,
  }
)
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "Accept a proposal and write it into its scope");

/** Record that a person refused it. Nothing is written anywhere else. */
const reject = HttpApiEndpoint.post(
  "reject",
  "/tasks/:taskId/proposals/:proposalId/reject",
  {
    error: [Forbidden, NotFound, ProposalAlreadyDecided],
    params: { proposalId: ProposalId, taskId: TaskId },
    payload: Schema.Struct({}),
    success: Proposal,
  }
)
  .middleware(AdminAccess)
  .annotate(OpenApi.Summary, "Refuse a proposal");

/** Proposals: what a run asked for above its own scope, and a person's answer. */
export class ProposalsGroup extends HttpApiGroup.make("proposals")
  .add(list, confirm, reject)
  .annotate(
    OpenApi.Description,
    "Proposals: changes a run asked a person to make to a directory it could not write."
  ) {}
