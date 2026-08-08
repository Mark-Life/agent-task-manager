import {
  ProjectId,
  ProposalId,
  ProposalPath,
  ProposalScope,
  ProposalState,
  RunId,
  TaskId,
  Timestamp,
  UserId,
  WorkspaceId,
} from "@workspace/domain";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema";
import { Schema } from "effect";
import { proposal } from "../schema/proposal";

/**
 * `path` is refined because the brand is the evidence that the path was checked
 * against `relativePathRefusalOf` — a row read back without it would hand a
 * writer a string it has to re-decide about, and the writer downstream is a
 * file write into a directory every later run reads.
 *
 * `body`, `content_hash` and `source_path` are deliberately left underived:
 * they are plainly text, so tracking the column is worth more than restating
 * `Schema.String` beside it.
 */
const columns = {
  decidedAt: () => Timestamp,
  decidedBy: () => UserId,
  id: () => ProposalId,
  path: () => ProposalPath,
  projectId: () => ProjectId,
  runId: () => RunId,
  scope: () => ProposalScope,
  state: () => ProposalState,
  taskId: () => TaskId,
  workspaceId: () => WorkspaceId,
};

/** A `proposal` row as the database hands it back. */
export const ProposalRow = createSelectSchema(proposal, {
  ...columns,
  createdAt: () => Timestamp,
  updatedAt: () => Timestamp,
});

/** What a collected proposal is written as, once per file the run left. */
export const ProposalInsert = createInsertSchema(proposal, columns);

/** What a decision changes, which is the state and the stamp and nothing else. */
export const ProposalUpdate = createUpdateSchema(proposal, columns);

/** Turns a raw row into the domain entity. */
export const decodeProposal = Schema.decodeUnknownEffect(ProposalRow);
