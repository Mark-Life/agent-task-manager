/**
 * Which chat a notice goes to, worked out from the board rather than
 * configured beside it.
 *
 * A run is started by the orchestrator and finishes without anybody watching,
 * so nothing on the run row says who wants to hear about it. What does say it
 * is the audit log: every board write a conversation caused carries that
 * conversation's id in `actor_thread_id`, so the newest entry on the task that
 * names a thread names the chat that asked for this work. That is the whole
 * routing rule, and it is why a manager token is minted with a thread id even
 * for a tapped button — the button is what makes the next notice land in the
 * chat the person tapped it in.
 *
 * Failing that, the notice goes to the chats the deployment already trusts:
 * the allow-listed accounts for that workspace, current thread where one
 * exists. This is the "somebody started this from the dashboard" case, and a
 * notice in the right workspace's chat is worth more than silence — a person
 * who did not ask for it can ignore one line, while a failed run nobody hears
 * about is the failure mode this whole path exists to prevent.
 *
 * When neither answers there is no chat at all, and the caller says so in the
 * log and sends nothing. There is deliberately no third fallback to "the first
 * chat we know of": routing a workspace's work into another workspace's chat
 * is worse than not delivering it.
 *
 * That second rule is also the whole answer for a notice with no task behind it
 * — the restart announcement — which is why it is a function of its own here
 * rather than an `else` inside the first.
 */

import { AuditLogRepo, ChatThreadRepo } from "@workspace/db";
import type {
  AuditEntry,
  TaskId,
  UserId,
  WorkspaceId,
} from "@workspace/domain";
import { TelegramChatId, ThreadId } from "@workspace/domain";
import { Effect, Option, Schema } from "effect";
import { Allowlist } from "../telegram/allowlist";

/**
 * How far back a task's history is read looking for a conversation.
 *
 * Bounded because this runs per notification: a task worked on for a week has
 * thousands of entries, and a chat that touched it a thousand entries ago is
 * not the chat waiting for this answer.
 */
export const AUDIT_SCAN_LIMIT = 50;

/** How the destination was arrived at. Carried so a surprising route is explicable. */
export type NotifyTargetSource = "audit_thread" | "current_thread" | "chat";

/** One chat a notice is going to, and the conversation it belongs to if any. */
export interface NotifyTarget {
  readonly chatId: TelegramChatId;
  readonly source: NotifyTargetSource;
  /** Null when the chat has no conversation yet — the notice still goes out. */
  readonly threadId: ThreadId | null;
  /** Who the chat speaks for, for the row the send writes. */
  readonly userId: UserId | null;
}

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/**
 * Every chat this deployment trusts in one workspace, current thread where
 * there is one.
 *
 * The allow-list is the source because it is the only one that survives a
 * restart with nothing else running: it is read from the environment at boot,
 * before a database connection exists. That is what makes an announcement about
 * the system itself deliverable — there is no task to trace back to a
 * conversation, and the chats are known anyway.
 */
export const resolveWorkspaceChats = Effect.fn("Notify.resolveWorkspaceChats")(
  function* (options: { readonly workspaceId: WorkspaceId }) {
    const { workspaceId } = options;
    yield* Effect.annotateCurrentSpan({ workspaceId });

    const threads = yield* ChatThreadRepo;
    const allowlist = yield* Allowlist;

    const chats = allowlist.telegramUserIds.filter(
      (telegramUserId) =>
        allowlist.lookup(telegramUserId)?.workspaceId === workspaceId
    );

    return yield* Effect.forEach(chats, (telegramUserId) =>
      Effect.gen(function* () {
        // A private chat's id is the account's id, which is what the allow-list
        // holds. A group would need a thread to have been opened in it first,
        // and that thread is found by the audit branch in
        // {@link resolveNotifyTargets}.
        const chatId = TelegramChatId.make(telegramUserId);
        const thread = yield* threads.current({ chatId, workspaceId });
        return {
          chatId,
          source: thread === null ? "chat" : "current_thread",
          threadId: thread?.id ?? null,
          userId:
            thread?.userId ?? allowlist.lookup(telegramUserId)?.userId ?? null,
        } satisfies NotifyTarget;
      })
    );
  }
);

/**
 * The newest entry that names a conversation, as a thread id.
 *
 * Decoded rather than cast: the column is plain text with no foreign key, so a
 * value that is not one of our ids is a value to skip rather than a lookup to
 * make.
 */
const newestThreadId = (entries: readonly AuditEntry[]) => {
  for (const entry of entries) {
    const decoded = decodeThreadId(entry.actorThreadId);
    if (Option.isSome(decoded)) {
      return decoded.value;
    }
  }
  return null;
};

/**
 * Every chat that should hear about this task, best first.
 *
 * Empty is a real answer and the caller must handle it: a workspace with
 * nobody on the allow-list has no chat, and inventing one would put somebody
 * else's work in front of a person who cannot act on it.
 */
export const resolveNotifyTargets = Effect.fn("Notify.resolveTargets")(
  function* (options: {
    readonly taskId: TaskId;
    readonly workspaceId: WorkspaceId;
  }) {
    const { taskId, workspaceId } = options;
    yield* Effect.annotateCurrentSpan({ taskId, workspaceId });

    const audit = yield* AuditLogRepo;
    const threads = yield* ChatThreadRepo;

    const entries = yield* audit.forTask({
      limit: AUDIT_SCAN_LIMIT,
      taskId,
      workspaceId,
    });
    const threadId = newestThreadId(entries);

    if (threadId !== null) {
      const thread = yield* threads
        .byId({ id: threadId, workspaceId })
        .pipe(Effect.catchTag("Db.NotFound", () => Effect.succeed(null)));
      if (thread !== null) {
        return [
          {
            chatId: thread.chatId,
            source: "audit_thread",
            threadId: thread.id,
            userId: thread.userId,
          },
        ] as readonly NotifyTarget[];
      }
    }

    return yield* resolveWorkspaceChats({ workspaceId });
  }
);
