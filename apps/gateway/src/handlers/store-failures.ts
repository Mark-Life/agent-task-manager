/**
 * The store's failures, as the failures this API promises.
 *
 * `@workspace/api` declares the wire vocabulary and writes the mapping down;
 * this is that mapping as code, in one place rather than once per handler,
 * because a repository failure translated two different ways in two files is
 * two different statuses for one condition.
 *
 * Only the translations are here. Which of them a given endpoint may perform is
 * the contract's business: a handler catches exactly the tags its operation
 * declares, so an endpoint that grows a new failure is a compile error in the
 * handler rather than a 500 in production.
 *
 * `Db.MalformedRow` and `Db.PersistenceError` are not translated — they are
 * killed. A row that no longer decodes and a driver that fell over are not
 * things a caller did or can act on, and giving either a documented name on the
 * wire would invite an agent to branch on it.
 */

import {
  IllegalDeletion,
  IllegalInitialStatus,
  IllegalTransition,
  InvalidInput,
  NotFound,
} from "@workspace/api";
import type {
  IllegalDeletion as StoreIllegalDeletion,
  IllegalInitialStatus as StoreIllegalInitialStatus,
  IllegalTransition as StoreIllegalTransition,
  InvalidInput as StoreInvalidInput,
  NotFound as StoreNotFound,
} from "@workspace/db";
import { Effect } from "effect";

/**
 * The two failures nobody can act on, spread into a `catchTags` table. Kept as
 * one value so no handler can remember one of them and forget the other.
 */
export const storeDefects = {
  "Db.MalformedRow": Effect.die,
  "Db.PersistenceError": Effect.die,
} as const;

/**
 * Whatever the store refused the write for, as something a person reading a
 * response can act on. A schema failure carries its own message; the empty
 * patch carries a plain string.
 */
const detailOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** No such row in this workspace — the id alone never answers that. */
export const toNotFound = (failure: StoreNotFound) =>
  Effect.fail(new NotFound({ entity: failure.entity, id: failure.id }));

/** The body decoded and the store still refused its contents. */
export const toInvalidInput = (failure: StoreInvalidInput) =>
  Effect.fail(
    new InvalidInput({
      detail: detailOf(failure.cause),
      entity: failure.entity,
    })
  );

/** The move is not in the status machine, or is but not for this actor. */
export const toIllegalTransition = (failure: StoreIllegalTransition) =>
  Effect.fail(
    new IllegalTransition({
      actorKind: failure.actorKind,
      from: failure.from,
      taskId: failure.taskId,
      to: failure.to,
    })
  );

/** This kind of actor may not erase a task, whatever its token is good for. */
export const toIllegalDeletion = (failure: StoreIllegalDeletion) =>
  Effect.fail(
    new IllegalDeletion({
      actorKind: failure.actorKind,
      taskId: failure.taskId,
    })
  );

/** The task would have been filed into a column this actor may not reach. */
export const toIllegalInitialStatus = (failure: StoreIllegalInitialStatus) =>
  Effect.fail(
    new IllegalInitialStatus({
      actorKind: failure.actorKind,
      status: failure.status,
    })
  );
