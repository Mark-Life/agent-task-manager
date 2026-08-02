/**
 * The chat tables against a real Postgres, because every claim worth making
 * here is the database's: one current thread per chat is a partial unique
 * index, a thread's ordering key moves in the same transaction as the message
 * that moved it, and a duplicate notice is refused by a unique key rather than
 * by a check somebody remembered to write.
 *
 * A random chat id per run keeps the rows this file writes out of everything
 * else's way, and deleting the threads at the end takes the messages with them
 * through the cascade — which is itself part of what is asserted.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { PgClient } from "@effect/sql-pg";
import type { WorkspaceId } from "@workspace/domain";
import { newTaskId, TelegramChatId, UserId } from "@workspace/domain";
import { DateTime, Effect, ManagedRuntime, Schema } from "effect";
import { storeLayer } from "../store";
import { ChatMessageRepo } from "./chat-message";
import { ChatNotificationRepo } from "./chat-notification";
import { ChatThreadRepo } from "./chat-thread";
import { WorkspaceRepo } from "./workspace";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "db-chat-test";

/** The database has never been seeded, so there is no workspace to hang a thread on. */
class NoWorkspace extends Schema.TaggedErrorClass<NoWorkspace>()(
  "ChatRepoTest.NoWorkspace",
  { detail: Schema.String }
) {}

/** Telegram numbers a group chat negatively; the column is signed for that reason. */
const CHAT_ID_RANGE = 1_000_000_000;

const chatId = TelegramChatId.make(-Math.floor(Math.random() * CHAT_ID_RANGE));

const userId = UserId.make("chat-test-user");

const runtime = ManagedRuntime.make(
  storeLayer({ applicationName: APPLICATION_NAME })
);

let workspaceId: WorkspaceId;

beforeAll(async () => {
  workspaceId = await runtime.runPromise(
    Effect.gen(function* () {
      const workspaces = yield* WorkspaceRepo;
      const [first] = yield* workspaces.list();
      if (first === undefined) {
        return yield* Effect.fail(
          new NoWorkspace({ detail: "run `bun run db:seed` first" })
        );
      }
      return first.id;
    })
  );
});

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`delete from chat_notification where workspace_id = ${workspaceId} and dedupe_key like ${`${APPLICATION_NAME}:%`}`;
      // The messages go with the threads, through the composite cascade.
      yield* sql`delete from chat_thread where workspace_id = ${workspaceId} and chat_id = ${chatId}`;
    })
  );
  await runtime.dispose();
});

test("a conversation round-trips: open, say something, read the tail back", async () => {
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const threads = yield* ChatThreadRepo;
      const messages = yield* ChatMessageRepo;

      const thread = yield* threads.open({
        chatId,
        provider: "claude",
        userId,
        workspaceId,
      });

      yield* messages.append({
        body: "file a task to rename the deploy script",
        intakeKind: "text",
        role: "user",
        telegramChatId: chatId,
        threadId: thread.id,
        workspaceId,
      });
      yield* messages.append({
        body: "filed it in backlog",
        providerSessionId: "sess-1",
        role: "manager",
        telegramChatId: chatId,
        threadId: thread.id,
        workspaceId,
      });

      return {
        opened: thread,
        stored: yield* messages.recent({ threadId: thread.id, workspaceId }),
        touched: yield* threads.byId({ id: thread.id, workspaceId }),
      };
    })
  );

  expect(result.opened.isCurrent).toBe(true);
  expect(result.opened.status).toBe("active");
  expect(result.opened.providerSessionId).toBeNull();

  // Oldest first: the order a prompt is built in.
  expect(result.stored.map((message) => message.role)).toEqual([
    "user",
    "manager",
  ]);
  expect(result.stored[0]?.body).toBe(
    "file a task to rename the deploy script"
  );
  expect(result.stored[0]?.intakeKind).toBe("text");
  // The manager's own message carries no intake kind, which the row's CHECK
  // is what actually enforces.
  expect(result.stored[1]?.intakeKind).toBeNull();
  expect(result.stored[1]?.providerSessionId).toBe("sess-1");

  // The first message titled the thread and moved it up the list.
  expect(result.touched.title).toBe("file a task to rename the deploy script");
  expect(
    DateTime.toEpochMillis(result.touched.lastMessageAt)
  ).toBeGreaterThanOrEqual(DateTime.toEpochMillis(result.opened.lastMessageAt));
});

test("a chat has one current thread, and switching moves it", async () => {
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const threads = yield* ChatThreadRepo;

      const first = yield* threads.open({
        chatId,
        provider: "claude",
        title: "the first conversation",
        userId,
        workspaceId,
      });
      const second = yield* threads.open({
        chatId,
        provider: "claude",
        title: "the second conversation",
        userId,
        workspaceId,
      });

      const afterOpen = yield* threads.current({ chatId, workspaceId });
      yield* threads.setCurrent({ id: first.id, workspaceId });

      return {
        afterOpen,
        afterSwitch: yield* threads.current({ chatId, workspaceId }),
        displaced: yield* threads.byId({ id: second.id, workspaceId }),
        first,
        listed: yield* threads.listForChat({ chatId, workspaceId }),
        second,
      };
    })
  );

  // The newest thread holds currency until something takes it back.
  expect(result.afterOpen?.id).toBe(result.second.id);
  expect(result.afterSwitch?.id).toBe(result.first.id);
  // Opening the second took currency from the first, and switching took it back.
  expect(result.displaced.isCurrent).toBe(false);
  expect(result.displaced.status).toBe("active");
  expect(result.listed.length).toBeGreaterThanOrEqual(2);
});

test("clearing a conversation forgets the provider's session and keeps the thread", async () => {
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const threads = yield* ChatThreadRepo;
      const thread = yield* threads.open({
        chatId,
        provider: "claude",
        userId,
        workspaceId,
      });

      const resumable = yield* threads.setProviderSession({
        id: thread.id,
        providerSessionId: "sess-resume",
        workspaceId,
      });

      return {
        cleared: yield* threads.clearProviderSession({
          id: thread.id,
          workspaceId,
        }),
        resumable,
      };
    })
  );

  expect(result.resumable.providerSessionId).toBe("sess-resume");
  expect(result.cleared.providerSessionId).toBeNull();
  expect(result.cleared.id).toBe(result.resumable.id);
  expect(result.cleared.isCurrent).toBe(true);
});

test("a notice is claimed once, and the second attempt is refused", async () => {
  const taskId = newTaskId();
  const dedupeKey = `${APPLICATION_NAME}:run_finished:${taskId}`;

  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const notifications = yield* ChatNotificationRepo;
      const claim = {
        dedupeKey,
        kind: "run_finished",
        taskId,
        telegramChatId: chatId,
        workspaceId,
      } as const;

      const first = yield* notifications.claim(claim);
      const second = yield* notifications.claim(claim);
      if (first === null) {
        return yield* Effect.die("the first claim was refused");
      }

      return {
        first,
        second,
        sent: yield* notifications.markSent({
          id: first.id,
          telegramMessageId: null,
          workspaceId,
        }),
      };
    })
  );

  expect(result.first.sentAt).toBeNull();
  // No foreign key to the task: the ledger outlives what it announced.
  expect(result.first.threadId).toBeNull();
  expect(result.second).toBeNull();
  expect(result.sent.sentAt).not.toBeNull();
});
