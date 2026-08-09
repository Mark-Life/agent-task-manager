/**
 * Projects: a place tasks belong to, with or without a repository.
 *
 * The nullable `repoUrl` is the whole per-kind seam at this layer — a run either
 * clones something or gets an empty scratch directory — so a trip and a feature
 * live in the same table and neither needs a special case.
 */

import {
  newProjectId,
  type Project,
  type ProjectId,
  type WorkspaceId,
} from "@workspace/domain";
import { and, asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { Database } from "../client";
import { decodeProject, ProjectInsert, ProjectUpdate } from "../rows";
import { project } from "../schema/project";
import {
  auditCreate,
  auditDelete,
  audited,
  auditUpdate,
  changesOf,
  decodeMany,
  decodeOne,
  decodeRow,
  decodeWritten,
  encodeWrite,
  execute,
  firstRow,
  writableValues,
  writer,
} from "./audit";

/** Reads addressed by id match one row; the limit says so to the planner. */
const ONE = 1;

const ENTITY = "project";

/** A project is never addressed by id alone: every query names its workspace. */
export interface ProjectRef {
  readonly id: ProjectId;
  readonly workspaceId: WorkspaceId;
}

/**
 * What creating a project needs. Only the name and the workspace are required —
 * a project with no repository is an ordinary project, not a degenerate one.
 */
export interface ProjectCreate
  extends Pick<Project, "name" | "workspaceId">,
    Partial<Pick<Project, "description" | "repoDefaultBranch" | "repoUrl">> {}

/**
 * What may change on a project. The workspace is not among them: moving a row
 * between workspaces would strand every child the composite foreign keys hold
 * to it.
 */
export interface ProjectPatch
  extends Partial<
    Pick<Project, "description" | "name" | "repoDefaultBranch" | "repoUrl">
  > {}

const make = Effect.gen(function* () {
  const db = yield* Database;
  const write = writer(db);

  const refOf = (ref: ProjectRef) =>
    and(eq(project.workspaceId, ref.workspaceId), eq(project.id, ref.id));

  const create = Effect.fn("ProjectRepo.create")(function* (
    input: ProjectCreate
  ) {
    yield* Effect.annotateCurrentSpan({ workspaceId: input.workspaceId });

    const values = yield* encodeWrite({
      entity: ENTITY,
      schema: ProjectInsert,
      value: {
        description: input.description,
        id: newProjectId(),
        name: input.name,
        repoDefaultBranch: input.repoDefaultBranch,
        repoUrl: input.repoUrl,
        workspaceId: input.workspaceId,
      },
    });

    return yield* write(({ tx }) =>
      Effect.gen(function* () {
        const rows = yield* execute(
          "ProjectRepo.create",
          tx.insert(project).values(values).returning()
        );

        const created = yield* decodeWritten({
          decode: decodeProject,
          entity: ENTITY,
          operation: "ProjectRepo.create",
          rows,
        });

        return audited(
          created,
          auditCreate({
            entityId: created.id,
            entityType: ENTITY,
            taskId: null,
            workspaceId: created.workspaceId,
          })
        );
      })
    );
  });

  /**
   * Changes some fields of a project. The row is locked and read first, so the
   * audit row records what actually moved rather than what the caller sent —
   * a patch that repeats the value already stored logs nothing.
   */
  const update = Effect.fn("ProjectRepo.update")(function* (
    options: ProjectRef & { readonly fields: ProjectPatch }
  ) {
    yield* Effect.annotateCurrentSpan({
      projectId: options.id,
      workspaceId: options.workspaceId,
    });

    const encoded = yield* encodeWrite({
      entity: ENTITY,
      schema: ProjectUpdate,
      value: options.fields,
    });

    // Before the transaction: an `UPDATE` with no assignments is not a
    // statement the driver can build, and it throws where it tries to, outside
    // every Effect boundary.
    const values = yield* writableValues({ entity: ENTITY, values: encoded });

    return yield* write(({ tx }) =>
      Effect.gen(function* () {
        const locked = yield* execute(
          "ProjectRepo.update",
          tx
            .select()
            .from(project)
            .where(refOf(options))
            .limit(ONE)
            .for("update")
        );

        const before = yield* firstRow({
          entity: ENTITY,
          id: options.id,
          rows: locked,
        });

        const rows = yield* execute(
          "ProjectRepo.update",
          tx.update(project).set(values).where(refOf(options)).returning()
        );

        const updated = yield* decodeWritten({
          decode: decodeProject,
          entity: ENTITY,
          operation: "ProjectRepo.update",
          rows,
        });

        return audited(
          updated,
          auditUpdate({
            changes: changesOf({ after: values, before }),
            entityId: updated.id,
            entityType: ENTITY,
            taskId: null,
            workspaceId: updated.workspaceId,
          })
        );
      })
    );
  });

  /**
   * Erases a project. Its tasks are not erased with it — the foreign key nulls
   * their `project_id`, because a task that outlived its project is still work
   * somebody wanted done. What does go is the project's promoted artifact
   * index, whose files belonged to the folder that is going away.
   *
   * The audit row outlives the project: `entityId` carries no foreign key, so
   * the log is the only remaining evidence it existed.
   */
  const remove = Effect.fn("ProjectRepo.delete")(function* (
    options: ProjectRef
  ) {
    yield* Effect.annotateCurrentSpan({
      projectId: options.id,
      workspaceId: options.workspaceId,
    });

    return yield* write(({ tx }) =>
      Effect.gen(function* () {
        const rows = yield* execute(
          "ProjectRepo.delete",
          tx.delete(project).where(refOf(options)).returning()
        );

        const row = yield* firstRow({
          entity: ENTITY,
          id: options.id,
          rows,
        });

        const deleted = yield* decodeRow({
          decode: decodeProject,
          entity: ENTITY,
          row,
        });

        return audited(
          deleted,
          auditDelete({
            entityId: deleted.id,
            entityType: ENTITY,
            taskId: null,
            workspaceId: deleted.workspaceId,
          })
        );
      })
    );
  });

  const byId = Effect.fn("ProjectRepo.byId")(function* (options: ProjectRef) {
    yield* Effect.annotateCurrentSpan({
      projectId: options.id,
      workspaceId: options.workspaceId,
    });

    const rows = yield* execute(
      "ProjectRepo.byId",
      db.select().from(project).where(refOf(options)).limit(ONE)
    );

    return yield* decodeOne({
      decode: decodeProject,
      entity: ENTITY,
      id: options.id,
      rows,
    });
  });

  /** Every project in the workspace, by name — the order a picker wants. */
  const list = Effect.fn("ProjectRepo.list")(function* (options: {
    readonly workspaceId: WorkspaceId;
  }) {
    yield* Effect.annotateCurrentSpan({ workspaceId: options.workspaceId });

    const rows = yield* execute(
      "ProjectRepo.list",
      db
        .select()
        .from(project)
        .where(eq(project.workspaceId, options.workspaceId))
        .orderBy(asc(project.name))
    );

    return yield* decodeMany({ decode: decodeProject, entity: ENTITY, rows });
  });

  /**
   * Every repository this workspace's projects name, once each.
   *
   * Read at boot by the mirror sweep, which needs the set of repos something
   * still points at. Urls rather than rows: a project's name and its default
   * branch say nothing about which bare clone on disk is still wanted, and the
   * caller turns each url into a path with the same function that created it.
   */
  const repoUrls = Effect.fn("ProjectRepo.repoUrls")(function* (options: {
    readonly workspaceId: WorkspaceId;
  }) {
    yield* Effect.annotateCurrentSpan({ workspaceId: options.workspaceId });

    const rows = yield* execute(
      "ProjectRepo.repoUrls",
      db
        .selectDistinct({ repoUrl: project.repoUrl })
        .from(project)
        .where(eq(project.workspaceId, options.workspaceId))
    );

    return rows.flatMap((row) => (row.repoUrl === null ? [] : [row.repoUrl]));
  });

  return { byId, create, delete: remove, list, repoUrls, update } as const;
});

/** Projects. Every mutation writes its audit row in the same transaction. */
export class ProjectRepo extends Context.Service<
  ProjectRepo,
  Effect.Success<typeof make>
>()("@workspace/db/ProjectRepo") {
  static readonly layer = Layer.effect(ProjectRepo, make);
}
