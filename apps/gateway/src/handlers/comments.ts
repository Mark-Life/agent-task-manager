/**
 * Comments: the task's conversation, and the only channel that crosses
 * sessions.
 *
 * Two operations, because a thread that can be rewritten is not a record of
 * anything. What this file actually decides is attribution: the author is read
 * off the credential and never off the body, so nobody can sign as somebody
 * else, and an agent's comment carries the session and the run it spoke from —
 * which is what lets the next reader see "the review session found X" instead
 * of one undifferentiated voice.
 */

import { Api, Forbidden, Principal } from "@workspace/api";
import {
  type CommentAuthor,
  CommentRepo,
  TaskRepo,
  withActor,
} from "@workspace/db";
import { Actor } from "@workspace/domain";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { storeDefects, toInvalidInput, toNotFound } from "./store-failures";

/**
 * Who a comment is from, read off the actor the credential resolved to.
 *
 * `system` is the gateway writing on nobody's behalf, and the thread has no
 * shape for it: the row's checks allow a person, the manager speaking for one,
 * a session, or the loop, and nothing else. Rather than inventing a fifth voice
 * the database would refuse, the request is refused — a real credential that
 * does not reach this operation, which is exactly what 403 says.
 */
const authorOf = (actor: Actor): CommentAuthor | null =>
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
 * The `comments` group, implemented.
 *
 * Both repositories are taken at layer build — they are handles on the
 * process's connection pool — and the caller is read per request, so the audit
 * row written beside the comment names whoever posted it.
 */
export const commentsHandlers = HttpApiBuilder.group(
  Api,
  "comments",
  (handlers) =>
    Effect.gen(function* () {
      const comments = yield* CommentRepo;
      const tasks = yield* TaskRepo;

      return handlers.handleAll({
        append: ({ params, payload }) =>
          Effect.gen(function* () {
            const { actor, workspaceId } = yield* Principal;
            const author = authorOf(actor);

            if (author === null) {
              return yield* Effect.fail(
                new Forbidden({
                  reason: "a system credential has no voice in a task's thread",
                  required:
                    "a credential naming a person, a session or the loop",
                })
              );
            }

            // The store checks the task belongs to this workspace inside the
            // same transaction, so there is no read to do first: a comment on a
            // task that is not there fails as a missing task rather than as a
            // foreign key nobody can act on.
            return yield* comments
              .append({
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

            return yield* comments
              .forTask({ taskId: params.taskId, workspaceId })
              .pipe(Effect.catchTags(storeDefects));
          }),
      });
    })
);
