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
import { DateTime, Effect, ManagedRuntime } from "effect";
import { withActor } from "../actor";
import { storeLayer } from "../store";
import { ensureFixtureWorkspace } from "../testing/fixtures";
import { ChatMessageRepo } from "./chat-message";
import { ChatNotificationRepo } from "./chat-notification";
import { ChatThreadRepo } from "./chat-thread";
import { AgentSessionRepo } from "./session";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "db-chat-test";

/** Telegram numbers a group chat negatively; the column is signed for that reason. */
const CHAT_ID_RANGE = 1_000_000_000;

const chatId = TelegramChatId.make(-Math.floor(Math.random() * CHAT_ID_RANGE));

/** A second chat, so "another chat is holding it" is a state a test can build. */
const otherChatId = TelegramChatId.make(chatId - 1);

/** Enough of the workspace's conversations to find the ones written here. */
const LIST_LIMIT = 100;

const userId = UserId.make("chat-test-user");

/** Sessions are audited, so the test says who is opening them. */
const caller = { kind: "human", userId } as const;

const runtime = ManagedRuntime.make(
  storeLayer({ applicationName: APPLICATION_NAME })
);

let workspaceId: WorkspaceId;

beforeAll(async () => {
  workspaceId = await runtime.runPromise(
    Effect.gen(function* () {
      const fixture = yield* ensureFixtureWorkspace({
        suite: APPLICATION_NAME,
      });
      return fixture.workspace.id;
    })
  );
});

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`delete from chat_notification where workspace_id = ${workspaceId} and dedupe_key like ${`${APPLICATION_NAME}:%`}`;
      // The messages go with the threads, through the composite cascade.
      // By the user as well as by the chat: a conversation opened the way the
      // dashboard opens one has no chat id to find it by.
      yield* sql`delete from chat_thread where workspace_id = ${workspaceId} and (chat_id = ${chatId} or user_id = ${userId})`;
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

test("a conversation opened outside Telegram is listed for the workspace, and resuming it from a chat binds it there", async () => {
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const threads = yield* ChatThreadRepo;

      // What the gateway writes for a thread started in the dashboard: no
      // chat, and `is_current` set on a thread that is current in no chat.
      const fromDashboard = yield* threads.open({
        provider: "claude",
        title: "opened in the dashboard",
        userId,
        workspaceId,
      });
      const held = yield* threads.open({
        chatId,
        provider: "claude",
        title: "the chat's own",
        userId,
        workspaceId,
      });

      const beforeChat = yield* threads.listForChat({ chatId, workspaceId });
      const beforeWorkspace = yield* threads.listForWorkspace({
        limit: LIST_LIMIT,
        workspaceId,
      });

      const adopted = yield* threads.setCurrent({
        chatId,
        id: fromDashboard.id,
        workspaceId,
      });

      return {
        adopted,
        beforeChat,
        beforeWorkspace,
        current: yield* threads.current({ chatId, workspaceId }),
        displaced: yield* threads.byId({ id: held.id, workspaceId }),
        fromDashboard,
      };
    })
  );

  const idsIn = (rows: readonly { readonly id: string }[]) =>
    rows.map((row) => row.id);

  // The filter that hid it: a chat's list is `chat_id = ?`, and this thread
  // has none. The workspace's list — what the dashboard reads — has it.
  expect(idsIn(result.beforeChat)).not.toContain(result.fromDashboard.id);
  expect(idsIn(result.beforeWorkspace)).toContain(result.fromDashboard.id);

  // Resuming it from the chat is what gives it a chat to be answered into.
  expect(result.adopted.chatId).toBe(chatId);
  expect(result.adopted.isCurrent).toBe(true);
  expect(result.current?.id).toBe(result.fromDashboard.id);
  // And currency is still one per chat, which is the index's doing.
  expect(result.displaced.isCurrent).toBe(false);
});

test("a conversation another chat is holding cannot be taken by this one", async () => {
  const failure = await runtime.runPromise(
    Effect.gen(function* () {
      const threads = yield* ChatThreadRepo;

      const theirs = yield* threads.open({
        chatId: otherChatId,
        provider: "claude",
        title: "another chat's conversation",
        userId,
        workspaceId,
      });

      return yield* Effect.flip(
        threads.setCurrent({ chatId, id: theirs.id, workspaceId })
      );
    })
  );

  expect(failure._tag).toBe("Db.InvalidInput");
});

test("a conversation with no chat cannot be made current by a caller that names none", async () => {
  const failure = await runtime.runPromise(
    Effect.gen(function* () {
      const threads = yield* ChatThreadRepo;

      const fromDashboard = yield* threads.open({
        provider: "claude",
        title: "current in no chat",
        userId,
        workspaceId,
      });

      return yield* Effect.flip(
        threads.setCurrent({ id: fromDashboard.id, workspaceId })
      );
    })
  );

  expect(failure._tag).toBe("Db.InvalidInput");
});

test("a thread with an unread message is dispatchable, and stops being one at the watermark", async () => {
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const threads = yield* ChatThreadRepo;
      const messages = yield* ChatMessageRepo;
      const sessions = yield* AgentSessionRepo;

      const thread = yield* threads.open({
        chatId,
        provider: "claude",
        userId,
        workspaceId,
      });
      const asked = yield* messages.append({
        body: "what is left on the board?",
        intakeKind: "text",
        role: "user",
        telegramChatId: chatId,
        threadId: thread.id,
        workspaceId,
      });

      const queued = yield* threads.awaitingReply({ workspaceId });

      // A session that has been shown nothing is shown the whole thread.
      const session = yield* sessions.open({
        provider: "claude",
        subject: { id: thread.id, kind: "thread" },
        workspaceId,
      });
      const fresh = yield* messages.since({
        threadId: thread.id,
        watermark: null,
        workspaceId,
      });

      yield* sessions.advanceWatermark({
        id: session.id,
        unreadAt: asked.createdAt,
        unreadId: asked.id,
        workspaceId,
      });

      return {
        answered: yield* threads.awaitingReply({ workspaceId }),
        fresh,
        queued,
        thread,
      };
    }).pipe(withActor(caller))
  );

  expect(result.queued.map((thread) => thread.id)).toContain(result.thread.id);
  expect(result.fresh.map((message) => message.body)).toEqual([
    "what is left on the board?",
  ]);
  // Read is read: the watermark is what takes the thread back out of the queue.
  expect(result.answered.map((thread) => thread.id)).not.toContain(
    result.thread.id
  );
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
