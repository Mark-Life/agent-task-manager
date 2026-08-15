/**
 * Task messages: the task's conversation, and the only channel that crosses
 * sessions.
 *
 * Two operations, because a thread that can be rewritten is not a record of
 * anything. What this file actually decides is attribution: the author is read
 * off the credential and never off the body, so nobody can sign as somebody
 * else, and an agent's message carries the session and the run it spoke from —
 * which is what lets the next reader see "the review session found X" instead
 * of one undifferentiated voice.
 */

import { Api, Forbidden, Principal } from "@workspace/api";
import {
  type TaskMessageAuthor,
  TaskMessageRepo,
  TaskRepo,
  withActor,
} from "@workspace/db";
import { Actor } from "@workspace/domain";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { storeDefects, toInvalidInput, toNotFound } from "./store-failures";

/**
 * Who a message is from, read off the actor the credential resolved to.
 *
 * `system` is the gateway writing on nobody's behalf, and the thread has no
 * shape for it: the row's checks allow a person, the manager speaking for one,
 * a session, or the loop, and nothing else. Rather than inventing a fifth voice
 * the database would refuse, the request is refused — a real credential that
 * does not reach this operation, which is exactly what 403 says.
 */
const authorOf = (actor: Actor): TaskMessageAuthor | null =>
  Actor.match(actor, {
    human: (self) => ({ kind: "human", userId: self.userId }) as const,
    manager: (self) => ({ kind: "manager", userId: self.userId }) as const,
    orchestrator: (self) =>
      ({ kind: "orchestrator", runId: self.runId ?? null }) as const,
    system: () => null,
    worker_run: (self) =>
      ({
        kind: "agent",
        runId: self.runId,
        sessionId: self.sessionId,
      }) as const,
  });

/**
 * The `messages` group, implemented.
 *
 * Both repositories are taken at layer build — they are handles on the
 * process's connection pool — and the caller is read per request, so the audit
 * row written beside the message names whoever posted it.
 */
export const messagesHandlers = HttpApiBuilder.group(
  Api,
  "messages",
  (handlers) =>
    Effect.gen(function* () {
      const messages = yield* TaskMessageRepo;
      const tasks = yield* TaskRepo;

      return handlers.handleAll({
        // The task is read first because an empty thread and a task that does
        // not exist are the same answer otherwise, and a caller would take the
        // empty array for a real task nobody has said anything about.
        list: ({ params }) =>
          Effect.gen(function* () {
            const { workspaceId } = yield* Principal;

            yield* tasks.byId({ id: params.taskId, workspaceId }).pipe(
              Effect.catchTags({
                ...storeDefects,
                "Db.NotFound": toNotFound,
              })
            );

            return yield* messages
              .forTask({ taskId: params.taskId, workspaceId })
              .pipe(Effect.catchTags(storeDefects));
          }),

        post: ({ params, payload }) =>
          Effect.gen(function* () {
            const { actor, workspaceId } = yield* Principal;
            const author = authorOf(actor);

            if (author === null) {
              return yield* new Forbidden({
                reason: "a system credential has no voice in a task's thread",
                required: "a credential naming a person, a session or the loop",
              });
            }

            // The store checks the task belongs to this workspace inside the
            // same transaction, so there is no read to do first: a message on a
            // task that is not there fails as a missing task rather than as a
            // foreign key nobody can act on.
            return yield* messages
              .post({
                ...payload,
                author,
                taskId: params.taskId,
                workspaceId,
              })
              .pipe(
                withActor(actor),
                Effect.catchTags({
                  ...storeDefects,
                  "Db.InvalidInput": toInvalidInput,
                  "Db.NotFound": toNotFound,
                })
              );
          }),
      });
    })
);
