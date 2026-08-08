/**
 * The index of what a run kept, and the two shapes that change it.
 *
 * Bytes are never in the index — Postgres is fast for metadata, the filesystem
 * is fast for bytes — so reading a file is its own operation returning a stream
 * and this file describes only what surrounds it.
 */

import {
  type ArtifactScope,
  Artifact as DomainArtifact,
} from "@workspace/domain";
import { Schema } from "effect";
import { Multipart } from "effect/unstable/http";
import { HttpApiSchema } from "effect/unstable/httpapi";

/** One kept file, exactly as the store indexes it. */
export const Artifact = DomainArtifact.annotate({ identifier: "Artifact" });

export interface Artifact extends Schema.Schema.Type<typeof Artifact> {}

/**
 * A file put into a task's own folder — the only one of the three mounts that
 * is writable. `path` is relative to that folder and is the natural key: an
 * upload to a path that already exists replaces the file and refreshes its row,
 * because the index is a cache of the directory and not a second history.
 */
export const ArtifactUpload = Schema.Struct({
  file: Multipart.SingleFileSchema,
  path: DomainArtifact.fields.path,
}).pipe(HttpApiSchema.asMultipart());

/**
 * Where a file is being promoted to. The project's folder is the usual answer —
 * promote once and every future task in that project sees it — and `global` is
 * for the material that turned out not to belong to any one project.
 *
 * `task` is not a destination: a file is already in its task's folder, and
 * promoting it there would be a decision with no effect and an audit row
 * claiming otherwise.
 */
export const PROMOTION_SCOPES = [
  "project",
  "global",
] as const satisfies readonly ArtifactScope[];

/** The scope a promotion copies into. */
export const PromotionScope = Schema.Literals(PROMOTION_SCOPES);
export type PromotionScope = typeof PromotionScope.Type;

/**
 * The deliberate verb. Copying the bytes is the server's job — reuse is always
 * a copy and never a reference, so that one task's record of what it worked
 * from cannot be made retroactively false by someone refining the original —
 * and the audit row beside it is what records that somebody chose to keep this
 * file, which no write by a run itself can say.
 */
export const ArtifactPromotion = Schema.Struct({
  scope: PromotionScope,
}).annotate({ identifier: "ArtifactPromotion" });

export interface ArtifactPromotion
  extends Schema.Schema.Type<typeof ArtifactPromotion> {}
