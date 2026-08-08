/**
 * A change a run asked for in a directory it could not write.
 *
 * The body is on the entity rather than behind a second read, and it is the one
 * place in this contract where a document travels with its index row. A person
 * deciding has to see what they are accepting, and the alternative — a list
 * call plus a read call per row — turns a page of three proposals into four
 * requests to answer one question.
 */

import { Proposal as DomainProposal } from "@workspace/domain";
import type { Schema } from "effect";

/** One pending or decided change, exactly as the store holds it. */
export const Proposal = DomainProposal.annotate({ identifier: "Proposal" });

export interface Proposal extends Schema.Schema.Type<typeof Proposal> {}
