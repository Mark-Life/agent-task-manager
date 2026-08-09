/**
 * The files a run kept.
 *
 * The index and the bytes are answered separately on purpose: metadata is a
 * database query and content is a file read, and putting bytes in the index
 * would bloat the write-ahead log and every backup forever. So `list` is JSON
 * and `read` is a stream straight off disk.
 *
 * A run writes its own task folder and, on a task that has a project, that
 * project's. The global folder is a read-only mount to every worker, and
 * {@link promote} is the deliberate verb that copies into either shared folder
 * — a promotion is somebody deciding a file is worth keeping, where a run's own
 * write is a side effect of the work, and only the first leaves an audit row.
 *
 * Both folders anyone can reach are listable: a task's, and the project's that
 * outlives it. Without the second, a document a research task left for the next
 * task in the project could be found only by somebody who already knew its path.
 */

import { ArtifactId, ProjectId, TaskId } from "@workspace/domain";
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi";
import {
  ArtifactAlreadyPromoted,
  Forbidden,
  InvalidInput,
  NotFound,
  PayloadTooLarge,
} from "../errors";
import {
  Artifact,
  ArtifactPromotion,
  ArtifactUpload,
} from "../schemas/artifact";
import { ReadAccess, TaskWriteAccess } from "../security";

/** A task's files, most recently written first — the order the panel shows. */
const list = HttpApiEndpoint.get("list", "/tasks/:taskId/artifacts", {
  error: NotFound,
  params: { taskId: TaskId },
  success: Schema.Array(Artifact),
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "List a task's artifacts");

/**
 * A project's shared folder, most recently written first.
 *
 * The listing the writable project mount was missing: a research task leaves a
 * document there and a later task in the same project reads it, and until this
 * existed that document was reachable only by somebody who already knew its
 * path. A run's own writes and the copies a promotion put there are one list,
 * because they are one folder.
 */
const listProject = HttpApiEndpoint.get(
  "listProject",
  "/projects/:projectId/artifacts",
  {
    error: NotFound,
    params: { projectId: ProjectId },
    success: Schema.Array(Artifact),
  }
)
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "List a project's artifacts");

/**
 * The bytes, streamed. Untyped octets rather than a guess at the content type:
 * the index records the extension, and a renderer picks from that rather than
 * from a header this endpoint would have to invent.
 */
const read = HttpApiEndpoint.get(
  "read",
  "/tasks/:taskId/artifacts/:artifactId/content",
  {
    error: NotFound,
    params: { artifactId: ArtifactId, taskId: TaskId },
    success: HttpApiSchema.StreamUint8Array(),
  }
)
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "Download an artifact");

/**
 * Put a file in the task's folder. `path` is relative to that folder and is the
 * natural key: uploading to a path that exists replaces the file and refreshes
 * its row, because the index is a cache of the directory rather than a history
 * of it.
 */
const upload = HttpApiEndpoint.post("upload", "/tasks/:taskId/artifacts", {
  error: [InvalidInput, NotFound, PayloadTooLarge],
  params: { taskId: TaskId },
  payload: ArtifactUpload,
  success: Artifact,
})
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Upload an artifact into a task's folder");

/**
 * Keep it beyond the task that made it: copy into the project's folder, which
 * every future task in that project then sees, or into the global one.
 *
 * A copy, never a reference. If task B pointed at task A's file and A were later
 * refined, B's record of what it actually worked from would become retroactively
 * false — so the bytes are copied and the copy is hashed, which is the one
 * moment "are these the same bytes" is worth answering.
 *
 * `task-write` and not admin, because the ordinary promotion is into a project's
 * folder, which a run may write anyway. The global folder is the one every run
 * of every project reads, and a run reaches it only through a proposal a person
 * accepted — so the handler refuses that destination to anyone but a person, and
 * that refusal is the {@link Forbidden} here.
 */
const promote = HttpApiEndpoint.post(
  "promote",
  "/tasks/:taskId/artifacts/:artifactId/promote",
  {
    error: [ArtifactAlreadyPromoted, Forbidden, NotFound],
    params: { artifactId: ArtifactId, taskId: TaskId },
    payload: ArtifactPromotion,
    success: Artifact,
  }
)
  .middleware(TaskWriteAccess)
  .annotate(OpenApi.Summary, "Promote an artifact to the project or globally");

/** Artifacts: the index, the bytes, and the one verb that shares them. */
export class ArtifactsGroup extends HttpApiGroup.make("artifacts")
  .add(list, listProject, read, upload, promote)
  .annotate(
    OpenApi.Description,
    "Artifacts: files a run kept, and the promotion that shares them."
  ) {}
