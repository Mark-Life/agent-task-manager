/**
 * The write path every repository shares: the mutation and the audit row that
 * describes it, in one transaction.
 *
 * Three kinds of writer touch this database and two of them are agents, so the
 * question "who changed this" has to have an answer for every row. Leaving that
 * to discipline does not survive contact with a repository written in a hurry,
 * so the audit row is made the only way out instead: `writer` runs a body whose
 * result must be an {@link Audited} value, and `audited` is the only thing that
 * builds one. A body that returns the entity it just wrote does not compile.
 *
 * Because the whole body runs inside `db.transaction`, a mutation whose audit
 * row cannot be inserted is a mutation that never happened.
 *
 * Three tables are exempt, and the exemption is spelled out in a type rather
 * than left to a comment: {@link unauditedTransaction} takes the name of the
 * table it is writing, and the only names it accepts are the three whose rows
 * are already the record of what happened — `run_event` and `run_command`,
 * which are append-only logs of their own, and `artifact`, which is a cache of
 * a directory. A fourth table joining them is then a deliberate edit to that
 * union, not a forgotten import.
 *
 * The errors below are the vocabulary every repository fails with. They are
 * separated by what a caller can do about them: retry the request
 * ({@link PersistenceError}), fix the request ({@link InvalidInput}), stop
 * asking for a row that is not there ({@link NotFound}), or page someone
 * because stored data no longer matches the schema ({@link MalformedRow}).
 */

import {
  type Actor,
  type AuditAction,
  type AuditChanges,
  type AuditEntityType,
  flattenActor,
  newAuditEntryId,
  type TaskId,
  type TaskStatus,
  type WorkspaceId,
} from "@workspace/domain";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors";
import { type Context, Effect, Schema } from "effect";
import { CurrentActor } from "../actor";
import type { Database } from "../client";
import { AuditEntryInsert } from "../rows";
import { auditEntry } from "../schema/audit";

/** The handle a repository is built over, as the {@link Database} service holds it. */
export type DatabaseHandle = Context.Service.Shape<typeof Database>;

/**
 * The handle inside a transaction. Derived from `transaction` itself so it
 * cannot drift from what the driver actually hands the callback.
 */
export type Transaction = Parameters<
  Parameters<DatabaseHandle["transaction"]>[0]
>[0];

/**
 * The database refused or failed the statement — a lost connection, a
 * constraint, a deadlock. The operation is named so the failure says which
 * repository call produced it without a stack trace.
 */
export class PersistenceError extends Schema.TaggedErrorClass<PersistenceError>()(
  "Db.PersistenceError",
  { cause: Schema.Unknown, operation: Schema.String }
) {}

/**
 * What the caller asked to write is not writable: an empty title, a value
 * outside a literal union. Raised where the write is encoded, so bad input
 * fails as a value rather than as a defect the process dies on.
 */
export class InvalidInput extends Schema.TaggedErrorClass<InvalidInput>()(
  "Db.InvalidInput",
  { cause: Schema.Unknown, entity: Schema.String }
) {}

/** No row with that id in that workspace. Scoping is why both halves are named. */
export class NotFound extends Schema.TaggedErrorClass<NotFound>()(
  "Db.NotFound",
  { entity: Schema.String, id: Schema.String }
) {}

/**
 * A stored row no longer decodes into its domain entity. Not a caller's
 * problem: it means a column was written behind the schema's back, or a
 * migration and a deploy went out in the wrong order.
 */
export class MalformedRow extends Schema.TaggedErrorClass<MalformedRow>()(
  "Db.MalformedRow",
  { cause: Schema.Unknown, entity: Schema.String }
) {}

/**
 * Runs one drizzle query and names the operation that issued it. Every query in
 * this package goes through here, so a driver failure reaches a caller as one
 * of our errors and nothing above the repositories imports drizzle to catch it.
 */
export const execute = <A, R>(
  operation: string,
  query: Effect.Effect<A, EffectDrizzleQueryError, R>
) =>
  Effect.mapError(query, (cause) => new PersistenceError({ cause, operation }));

/**
 * The encoded row, with every brand and literal the schema's type side carried
 * back over. A field is only narrowed where the domain type is already one of
 * the encoded type's values, so a `DateTime.Utc` still encodes to a `Date` and
 * only the fields that were the same value all along keep their name.
 */
export type BrandedEncoded<S extends Schema.Constraint> = {
  [K in keyof S["Encoded"]]: K extends keyof S["Type"]
    ? S["Type"][K] extends S["Encoded"][K]
      ? S["Type"][K]
      : S["Encoded"][K]
    : S["Encoded"][K];
};

/**
 * Encodes what a repository is about to write through the table's own insert or
 * update schema, so the branded ids, literal unions and zone-aware instants the
 * domain deals in become the values the column actually takes. A value the
 * schema rejects is the caller's mistake, and it fails as {@link InvalidInput}.
 *
 * The result keeps the branded types the caller passed in. Encoding a brand
 * erases it — a `TaskId` encodes to the `string` it always was — but the column
 * it is about to be written to is `$type`d with that brand, so the type has to
 * survive a step that does not change the value. The assertion is exactly that
 * gap and nothing wider: every field has just been validated by the schema
 * whose brand is being restored.
 */
export const encodeWrite = <S extends Schema.Constraint>(options: {
  readonly entity: string;
  readonly schema: S;
  readonly value: S["Type"];
}) =>
  Effect.mapError(
    Schema.encodeEffect(options.schema)(options.value),
    (cause) => new InvalidInput({ cause, entity: options.entity })
  ) as Effect.Effect<BrandedEncoded<S>, InvalidInput>;

/**
 * Refuses a patch that would set nothing at all.
 *
 * An `UPDATE` with no assignments is not a statement Postgres has, and the
 * driver throws where it builds one — synchronously, outside every Effect
 * boundary, so an empty patch would reach a caller as a dead fiber rather than
 * as a failure. Every write path checks here instead, before the builder is
 * touched, and a request that changes nothing comes back as the ordinary
 * invalid input it is.
 */
export const writableValues = <V extends object>(options: {
  readonly entity: string;
  readonly values: V;
}) =>
  Object.values(options.values).some((value) => value !== undefined)
    ? Effect.succeed(options.values)
    : Effect.fail(
        new InvalidInput({
          cause: "no fields to update",
          entity: options.entity,
        })
      );

/** The row a scoped query matched, or {@link NotFound} when it matched nothing. */
export const firstRow = <Row>(options: {
  readonly entity: string;
  readonly id: string;
  readonly rows: readonly Row[];
}): Effect.Effect<Row, NotFound> => {
  const [row] = options.rows;
  return row === undefined
    ? Effect.fail(new NotFound({ entity: options.entity, id: options.id }))
    : Effect.succeed(row);
};

const malformed = (entity: string) => (cause: unknown) =>
  new MalformedRow({ cause, entity });

/**
 * Decodes a row into its domain entity — validated, never asserted, so
 * `jsonb().$type<X>()` and every other unchecked cast in the schema becomes
 * true at the point a repository hands the value out.
 *
 * Separate from {@link decodeOne} for the write path, which needs the row as it
 * was as well as what it means: the audit row's `changes` is a diff against
 * stored columns, and the entity is what the caller gets back.
 */
export const decodeRow = <Row, A, E>(options: {
  readonly decode: (row: Row) => Effect.Effect<A, E>;
  readonly entity: string;
  readonly row: Row;
}) => Effect.mapError(options.decode(options.row), malformed(options.entity));

/** The one row a scoped read matched, decoded. */
export const decodeOne = <Row, A, E>(options: {
  readonly decode: (row: Row) => Effect.Effect<A, E>;
  readonly entity: string;
  readonly id: string;
  readonly rows: readonly Row[];
}) =>
  Effect.flatMap(firstRow(options), (row) =>
    decodeRow({ decode: options.decode, entity: options.entity, row })
  );

/**
 * Decodes the row a write handed back through `returning()`. Separate from
 * {@link decodeOne} because an insert or a scoped update that reached this
 * point matched something by construction — an empty result is the database
 * misbehaving, not a missing row, and calling it {@link NotFound} would put a
 * 404 in the error type of every create.
 */
export const decodeWritten = <Row, A, E>(options: {
  readonly decode: (row: Row) => Effect.Effect<A, E>;
  readonly entity: string;
  readonly operation: string;
  readonly rows: readonly Row[];
}) => {
  const [row] = options.rows;
  return row === undefined
    ? Effect.fail(
        new PersistenceError({
          cause: `${options.entity}: the write returned no row`,
          operation: options.operation,
        })
      )
    : Effect.mapError(options.decode(row), malformed(options.entity));
};

/** Decodes every row of a list query. */
export const decodeMany = <Row, A, E>(options: {
  readonly decode: (row: Row) => Effect.Effect<A, E>;
  readonly entity: string;
  readonly rows: readonly Row[];
}) =>
  Effect.mapError(
    Effect.forEach(options.rows, options.decode),
    malformed(options.entity)
  );

/**
 * One value as the audit log stores it. `JSON.stringify` is both the comparison
 * and the storage form: it turns the `Date` a `timestamptz` column round-trips
 * into the ISO string jsonb can hold, and it makes two values comparable
 * without a deep-equality pass. Two objects that differ only in key order
 * compare as changed, which over-reports rather than losing a change.
 */
const jsonOf = (value: unknown) => JSON.stringify(value ?? null) ?? "null";

const changeOf = (
  before: unknown,
  after: unknown
): AuditChanges[string] | null => {
  const from = jsonOf(before);
  const to = jsonOf(after);
  return from === to ? null : { from: JSON.parse(from), to: JSON.parse(to) };
};

/**
 * `field -> { from, to }` for everything the write actually changed, computed
 * against the row as it was. Fields absent from the patch, and fields the patch
 * set to the value already there, are left out — an audit row claiming a change
 * that did not happen is worse than no entry, because someone will search for
 * the change and find the row.
 */
export const changesOf = (options: {
  readonly after: object;
  readonly before: object;
}) => {
  const before = new Map(Object.entries(options.before));
  return Object.fromEntries(
    Object.entries(options.after).flatMap(([field, value]) => {
      if (value === undefined) {
        return [];
      }
      const change = changeOf(before.get(field), value);
      return change === null ? [] : [[field, change] as const];
    })
  );
};

/**
 * One mutation, as the audit log will record it. It names its own workspace
 * rather than inheriting one from the call: the row describes an entity, and
 * that entity's workspace is the only one it can honestly claim.
 */
export interface AuditDraft {
  readonly action: AuditAction;
  readonly changes: AuditChanges;
  readonly entityId: string;
  readonly entityType: AuditEntityType;
  readonly fromStatus: TaskStatus | null;
  /** Denormalized, so a task's activity feed is one index scan. */
  readonly taskId: TaskId | null;
  readonly toStatus: TaskStatus | null;
  readonly workspaceId: WorkspaceId;
}

/** What every audit row names, whatever it did. */
interface AuditSubject {
  readonly entityId: string;
  readonly entityType: AuditEntityType;
  readonly taskId: TaskId | null;
  readonly workspaceId: WorkspaceId;
}

const draftOf = (
  action: AuditAction,
  subject: AuditSubject,
  changes: AuditChanges
) =>
  ({
    action,
    changes,
    entityId: subject.entityId,
    entityType: subject.entityType,
    fromStatus: null,
    taskId: subject.taskId,
    toStatus: null,
    workspaceId: subject.workspaceId,
  }) satisfies AuditDraft;

/** A row that did not exist before. The row itself is the record of what it holds. */
export const auditCreate = (subject: AuditSubject) =>
  draftOf("create", subject, {});

/** A field-level change. Pass {@link changesOf} for `changes`. */
export const auditUpdate = (
  subject: AuditSubject & { readonly changes: AuditChanges }
) => draftOf("update", subject, subject.changes);

/** A deliberate erasure. The log survives it: `entityId` has no foreign key. */
export const auditDelete = (subject: AuditSubject) =>
  draftOf("delete", subject, {});

/**
 * An artifact promoted out of the task that made it. Its own action because the
 * shared folders are read-only mounts, so this one deliberate step is the whole
 * audit trail for how anything got into one.
 */
export const auditPromote = (subject: Omit<AuditSubject, "entityType">) =>
  draftOf("promote", { ...subject, entityType: "artifact" }, {});

/**
 * A move on the board. Its own action and its own two columns rather than an
 * entry in `changes`, because "how did this task move through the columns" is
 * asked often enough to index.
 */
export const auditTransition = (options: {
  readonly changes: AuditChanges;
  readonly from: TaskStatus;
  readonly taskId: TaskId;
  readonly to: TaskStatus;
  readonly workspaceId: WorkspaceId;
}) =>
  ({
    action: "transition",
    changes: options.changes,
    entityId: options.taskId,
    entityType: "task",
    fromStatus: options.from,
    taskId: options.taskId,
    toStatus: options.to,
    workspaceId: options.workspaceId,
  }) satisfies AuditDraft;

/** The witness that a mutation described itself. Only {@link audited} mints one. */
export const AuditedTypeId: unique symbol = Symbol.for("@workspace/db/Audited");

/**
 * What a mutation hands back: the entity, and the audit rows that go with it.
 * The symbol is what makes this unforgeable — a repository cannot satisfy the
 * type by returning a plain object, so the only way to finish a mutation is to
 * say what it did.
 */
export interface Audited<out A> {
  readonly entries: readonly AuditDraft[];
  readonly value: A;
  readonly [AuditedTypeId]: typeof AuditedTypeId;
}

/**
 * Pairs the result of a mutation with what to record about it. At least one
 * entry is required by the signature: a mutation with nothing to say about
 * itself is a mutation that has slipped past the log.
 */
export const audited = <A>(
  value: A,
  entry: AuditDraft,
  ...rest: readonly AuditDraft[]
): Audited<A> => ({
  [AuditedTypeId]: AuditedTypeId,
  entries: [entry, ...rest],
  value,
});

/** What a mutation body is handed: the transaction, and who is writing. */
export interface WriteContext {
  readonly actor: Actor;
  readonly tx: Transaction;
}

/**
 * The trace the mutation belongs to, joining the audit row to the request or
 * the run that caused it. Absent outside a span, which is where a seed script
 * and a test live, so this is null rather than a failure.
 */
const currentTraceId = Effect.currentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => null)
);

const AUDIT_OPERATION = "AuditEntry.append";

/**
 * What an audited write names as its operation when the transaction itself
 * fails. Every repository shares it, because the failure is the same one
 * wherever it happened and the mutation's own errors are already specific.
 */
const TRANSACTION_OPERATION = "Repository.transaction";

const auditRow = (options: {
  readonly actor: Actor;
  readonly entry: AuditDraft;
  readonly traceId: string | null;
}) =>
  encodeWrite({
    entity: "audit_entry",
    schema: AuditEntryInsert,
    value: {
      ...flattenActor(options.actor),
      ...options.entry,
      id: newAuditEntryId(),
      traceId: options.traceId,
    },
  });

/**
 * Runs a body inside one transaction and reports a failure of the transaction
 * itself — BEGIN, COMMIT, a connection lost mid-write — as one of our errors,
 * named after the operation that opened it. Failures of the body pass through
 * untouched, so a caller still sees {@link NotFound} or an illegal transition
 * for what it is.
 */
const transaction =
  (db: DatabaseHandle) =>
  <A, E, R>(
    operation: string,
    body: (tx: Transaction) => Effect.Effect<A, E, R>
  ) =>
    db
      .transaction(body)
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(new PersistenceError({ cause, operation }))
        )
      );

/**
 * The tables a write may legitimately leave off the audit log, named so that
 * skipping it is a choice made in the type rather than a helper someone
 * imported. Their rows already say what happened: `run_event` and `run_command`
 * are append-only records in their own right — the command carries the actor
 * who asked in columns of its own — and `artifact` is a cache of a directory,
 * where a rescan is a refresh rather than a decision anyone made.
 */
export type UnauditedTable = "artifact" | "run_command" | "run_event";

/**
 * {@link transaction} for those three tables and nothing else. Every other
 * write goes through {@link writer}, which is this plus the audit row — and the
 * only way to name a fourth table here is to widen the union above, which is
 * exactly the edit that should be hard to make by accident.
 */
export const unauditedTransaction =
  (db: DatabaseHandle) =>
  <A, E, R>(
    scope: {
      readonly operation: string;
      readonly table: UnauditedTable;
    },
    body: (tx: Transaction) => Effect.Effect<A, E, R>
  ) =>
    transaction(db)(scope.operation, body);

/**
 * Binds the shared write path to one database handle. A repository builds this
 * once while its layer is being built, so the handle is resolved where the
 * service is and a repository method carries only the actor as a requirement.
 *
 * The returned function opens the transaction, runs the mutation, writes its
 * audit rows and commits — or rolls the lot back. A mutation whose audit row
 * cannot be inserted is a mutation that never happened.
 */
export const writer = (db: DatabaseHandle) => {
  const inTransaction = transaction(db);

  return <A, E, R>(
    mutation: (context: WriteContext) => Effect.Effect<Audited<A>, E, R>
  ) =>
    Effect.gen(function* () {
      const actor = yield* CurrentActor;
      const traceId = yield* currentTraceId;

      return yield* inTransaction(TRANSACTION_OPERATION, (tx) =>
        Effect.gen(function* () {
          const outcome = yield* mutation({ actor, tx });
          const values = yield* Effect.forEach(outcome.entries, (entry) =>
            auditRow({ actor, entry, traceId })
          );

          yield* execute(AUDIT_OPERATION, tx.insert(auditEntry).values(values));

          return outcome.value;
        })
      );
    });
};
