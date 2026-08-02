/**
 * Claim, send, stamp — the three steps that keep a restart from re-announcing
 * everything that happened while the bot was down.
 *
 * The ledger is the mechanism and there is no in-memory set anywhere in it. A
 * notice is written as a claim first, and the unique index on
 * `(workspace_id, dedupe_key)` decides who owns it: a second attempt at the
 * same `${kind}:${taskId}:${runId}` loses the insert and stops. Only then does
 * the message go out, and only after it does `sent_at` land. So the row says,
 * at every instant, either "nobody has this", "somebody took it and has not
 * delivered it yet", or "this was said, in this message".
 *
 * That ordering is chosen the way round it is on purpose. A crash between the
 * claim and the send leaves a row that looks undelivered, and the repair pass
 * picks it up once it is older than the grace period — so the failure mode is
 * a repeated "your run failed", not a missing one. At-least-once with a
 * bounded window: a duplicate is a nuisance, a silence is a lie.
 *
 * Every send leaves exactly one `atm.chat` row with `updateKind: "notify"`,
 * including the ones Telegram refused, which is what makes "the bot went quiet
 * on Tuesday" answerable from the ledger rather than from a hunch. One row per
 * chat written to, because the row carries the chat.
 */

import type {
  AuditLogRepo,
  ChatThreadRepo,
  RunRepo,
  TaskRepo,
} from "@workspace/db";
import { ChatNotificationRepo } from "@workspace/db";
import type {
  ChatNotification,
  NotifyKind,
  RunId,
  TaskId,
  WorkspaceId,
} from "@workspace/domain";
import { TelegramMessageId } from "@workspace/domain";
import type { Telemetry } from "@workspace/telemetry";
import { Context, DateTime, Duration, Effect, Layer, Ref } from "effect";
import type { InlineKeyboard } from "grammy";
import {
  emptyChatProgress,
  makeChatProgress,
  observeChat,
  withChatEvent,
} from "../chat-event";
import { stuckConfig } from "../stuck/config";
import {
  renderStuckAlert,
  type StuckAlert,
  StuckAnnouncer,
} from "../stuck/scan";
import type { Allowlist } from "../telegram/allowlist";
import { BotService } from "../telegram/bot-service";
import { sendText } from "../telegram/send";
import { renderNotice } from "./render";
import { type NotifyTarget, resolveNotifyTargets } from "./resolve";
import { describeNotice, type NoticeRequest } from "./summary";

/**
 * How long a claim may sit unsent before somebody else tries it again.
 *
 * It is a bound on how long a crash costs, and a floor under how long a send
 * is allowed to take: too short and a slow Telegram call is duplicated by the
 * repair pass while it is still in flight.
 */
export const DEFAULT_NOTIFY_RETRY_GRACE_MS = 60_000;

/**
 * The key two processes reaching for the same notice both compute.
 *
 * The run is in it because a task is announced once per attempt, and the kind
 * is in it because a run that finished and left work in `review` is two things
 * worth saying — the same run, deliberately not the same key.
 */
export const dedupeKeyOf = (options: {
  readonly kind: NotifyKind;
  readonly runId: RunId | null;
  readonly taskId: TaskId;
}) => `${options.kind}:${options.taskId}:${options.runId ?? "-"}`;

/** A message ready to go, with the identity that keeps it from going twice. */
export interface NotifyDelivery {
  readonly dedupeKey: string;
  readonly keyboard: InlineKeyboard | null;
  readonly kind: NotifyKind;
  readonly runId: RunId | null;
  readonly taskId: TaskId;
  readonly text: string;
  readonly workspaceId: WorkspaceId;
}

/** How the sender is tuned, and where a task lives on the web. */
export interface NotifierOptions {
  readonly retryGraceMs?: number;
  readonly splitAt?: number;
  /** The dashboard's address for a task, or null where there is no public URL. */
  readonly taskUrl?: (taskId: TaskId) => string | null;
}

/**
 * What the reads underneath this service need. Captured once at layer build
 * and pinned onto every method, so what a caller holds is a sender rather than
 * a sender plus five repositories — and so the stuck scan's announcer, whose
 * shape allows no requirements at all, can be built out of it.
 */
type NotifyReads =
  | Allowlist
  | AuditLogRepo
  | ChatThreadRepo
  | RunRepo
  | TaskRepo
  | Telemetry;

const make = (options: NotifierOptions) =>
  Effect.gen(function* () {
    const notifications = yield* ChatNotificationRepo;
    const telegram = yield* BotService;
    const services = yield* Effect.context<NotifyReads>();
    const retryGraceMs = options.retryGraceMs ?? DEFAULT_NOTIFY_RETRY_GRACE_MS;
    const taskUrlOf = options.taskUrl ?? (() => null);

    /**
     * One message into one chat, wrapped in the row that says it happened.
     *
     * The refusal is caught *outside* the wrap, so a message Telegram rejected
     * is an `errored` row rather than a `done` one — and the claim stays
     * unstamped, which is what hands it to the repair pass.
     */
    const sendOne = Effect.fnUntraced(function* (input: {
      readonly delivery: NotifyDelivery;
      readonly target: NotifyTarget;
    }) {
      const { delivery, target } = input;
      const progress = yield* makeChatProgress;
      yield* Ref.set(progress, {
        ...emptyChatProgress,
        notifyKind: delivery.kind,
        runId: delivery.runId,
        taskId: delivery.taskId,
        threadId: target.threadId,
        updateKind: "notify",
      });

      return yield* sendText({
        api: telegram.api,
        chatId: target.chatId,
        send: {
          link_preview_options: { is_disabled: true },
          parse_mode: "HTML",
          ...(delivery.keyboard === null
            ? {}
            : { reply_markup: delivery.keyboard }),
        },
        splitAt: options.splitAt,
        text: delivery.text,
      }).pipe(
        Effect.tap(() => observeChat({ replyChars: delivery.text.length })),
        // The last message carries the keyboard, so it is the one a tapped
        // button will be answering against.
        Effect.map((sent) => sent.at(-1)?.message_id ?? null),
        withChatEvent({
          chatId: String(target.chatId),
          progress,
          // A notice has no sender. The chat is the nearest true value, and for
          // the private chats this bot serves it is the account itself.
          telegramUserId: String(target.chatId),
          updateKind: "notify",
          userId: target.userId,
          workspaceId: delivery.workspaceId,
        }),
        Effect.catchTag("Telegram.ApiError", (error) =>
          Effect.as(
            Effect.logWarning("notification refused by Telegram", {
              chatId: target.chatId,
              dedupeKey: delivery.dedupeKey,
              reason: error.message,
            }),
            null
          )
        )
      );
    });

    /**
     * Sends a claim somebody already holds, and stamps it if any chat took it.
     *
     * Not stamping is the whole retry mechanism: a claim nobody could deliver
     * stays visible to the repair pass, and one that reached at least one chat
     * is finished with, because a person has been told.
     */
    const sendClaimed = Effect.fnUntraced(function* (input: {
      readonly claim: ChatNotification;
      readonly delivery: NotifyDelivery;
      readonly targets: readonly NotifyTarget[];
    }) {
      const { claim, delivery, targets } = input;
      const messageIds = yield* Effect.forEach(targets, (target) =>
        sendOne({ delivery, target })
      );
      const delivered = messageIds.find((id) => id !== null);
      if (delivered === undefined) {
        return null;
      }
      return yield* notifications.markSent({
        id: claim.id,
        telegramMessageId: TelegramMessageId.make(delivered),
        workspaceId: claim.workspaceId,
      });
    });

    /**
     * Takes the notice if it is going spare, and says it.
     *
     * Answers null in all three of the ways there is nothing to do: nowhere to
     * say it, somebody else already has it, and nobody took the message.
     */
    const dispatchIn = Effect.fn("Notify.dispatch")(function* (
      delivery: NotifyDelivery
    ) {
      yield* Effect.annotateCurrentSpan({
        taskId: delivery.taskId,
        workspaceId: delivery.workspaceId,
      });

      const targets = yield* resolveNotifyTargets({
        taskId: delivery.taskId,
        workspaceId: delivery.workspaceId,
      });
      const [primary] = targets;
      if (primary === undefined) {
        yield* Effect.logWarning("no chat to notify", {
          dedupeKey: delivery.dedupeKey,
          taskId: delivery.taskId,
          workspaceId: delivery.workspaceId,
        });
        return null;
      }

      const claim = yield* notifications.claim({
        dedupeKey: delivery.dedupeKey,
        kind: delivery.kind,
        runId: delivery.runId,
        taskId: delivery.taskId,
        telegramChatId: primary.chatId,
        threadId: primary.threadId,
        workspaceId: delivery.workspaceId,
      });
      if (claim === null) {
        return null;
      }

      return yield* sendClaimed({ claim, delivery, targets });
    });

    /**
     * A run event, turned into a message and delivered — the whole outbound
     * path behind one call.
     */
    const deliverIn = Effect.fn("Notify.deliver")(function* (
      request: NoticeRequest
    ) {
      const described = yield* describeNotice(request);
      if (described === null) {
        return null;
      }
      const rendered = renderNotice({
        notice: described.notice,
        taskUrl: taskUrlOf(request.taskId),
      });
      return yield* dispatchIn({
        dedupeKey: dedupeKeyOf({
          kind: described.kind,
          runId: request.runId,
          taskId: request.taskId,
        }),
        keyboard: rendered.keyboard,
        kind: described.kind,
        runId: request.runId,
        taskId: request.taskId,
        text: rendered.text,
        workspaceId: request.workspaceId,
      });
    });

    /**
     * The claims that were taken and never delivered, tried again.
     *
     * Rendered afresh rather than replayed: minutes have passed, and what a
     * person wants to read is what the task looks like now. The chat is the
     * claimed one, not a re-resolved one — the claim named a destination and
     * changing it would deliver the message somewhere the ledger does not say.
     *
     * A stuck alert is retired instead of retried. It is a statement about a
     * window that has passed, the scan will claim a new key if the run is
     * still going nowhere, and re-sending a stale one is telling somebody about
     * a fire that is either out or already burning somewhere new.
     */
    const repairIn = Effect.fn("Notify.repair")(function* (input: {
      readonly limit?: number;
      readonly workspaceId: WorkspaceId;
    }) {
      yield* Effect.annotateCurrentSpan({ workspaceId: input.workspaceId });

      const now = yield* DateTime.now;
      const stale = yield* notifications.unsentBefore({
        claimedBefore: DateTime.subtractDuration(
          now,
          Duration.millis(retryGraceMs)
        ),
        limit: input.limit,
        workspaceId: input.workspaceId,
      });

      const retire = (claim: ChatNotification) =>
        notifications
          .markSent({
            id: claim.id,
            telegramMessageId: null,
            workspaceId: claim.workspaceId,
          })
          .pipe(Effect.asVoid);

      yield* Effect.forEach(stale, (claim) =>
        Effect.gen(function* () {
          if (claim.kind === "stuck") {
            yield* retire(claim);
            return;
          }
          const described = yield* describeNotice({
            kind: claim.kind,
            runId: claim.runId,
            taskId: claim.taskId,
            workspaceId: claim.workspaceId,
          });
          if (described === null) {
            yield* retire(claim);
            return;
          }
          const rendered = renderNotice({
            notice: described.notice,
            taskUrl: taskUrlOf(claim.taskId),
          });
          yield* sendClaimed({
            claim,
            delivery: {
              dedupeKey: claim.dedupeKey,
              keyboard: rendered.keyboard,
              kind: claim.kind,
              runId: claim.runId,
              taskId: claim.taskId,
              text: rendered.text,
              workspaceId: claim.workspaceId,
            },
            targets: [
              {
                chatId: claim.telegramChatId,
                source: "chat",
                threadId: claim.threadId,
                userId: null,
              },
            ],
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("notification retry failed", cause).pipe(
              Effect.annotateLogs({ dedupeKey: claim.dedupeKey })
            )
          )
        )
      );

      return stale.length;
    });

    /** A run event, said out loud. Null when there was nothing to say. */
    const deliver = (request: NoticeRequest) =>
      Effect.provideContext(deliverIn(request), services);

    /** A message somebody else rendered, claimed and sent on the same ledger. */
    const dispatch = (delivery: NotifyDelivery) =>
      Effect.provideContext(dispatchIn(delivery), services);

    /** The claims that were taken and never delivered, tried again. */
    const repair = (input: {
      readonly limit?: number;
      readonly workspaceId: WorkspaceId;
    }) => Effect.provideContext(repairIn(input), services);

    return { deliver, dispatch, repair, retryGraceMs, taskUrlOf } as const;
  });

/**
 * Everything the bot volunteers goes through here.
 *
 * One service rather than a function per caller, because the claim ledger only
 * suppresses duplicates if every sender writes to it — a second send path that
 * skipped the claim would be a second announcement of the same run, and the
 * ledger would say it never happened.
 */
export class Notifier extends Context.Service<
  Notifier,
  Effect.Success<ReturnType<typeof make>>
>()("@workspace/bot/Notifier") {
  static readonly layer = (options: NotifierOptions = {}) =>
    Layer.effect(Notifier, make(options));
}

/**
 * The stuck scan's outlet: the same claim, the same resolution, the same
 * ledger as every other notice.
 *
 * The scan renders its own message — it is the only thing that knows what the
 * run kept repeating — and hands over a dedupe key that already counts
 * windows, so a run that stays stuck is one message per window rather than one
 * per tick.
 */
export const stuckAnnouncerLayer = Layer.effect(
  StuckAnnouncer,
  Effect.gen(function* () {
    const notifier = yield* Notifier;
    const stuck = yield* stuckConfig;

    const announce = (alert: StuckAlert) => {
      const rendered = renderStuckAlert({
        alert,
        taskUrl: notifier.taskUrlOf(alert.task.id),
        windowMinutes: stuck.thresholds.windowMinutes,
      });
      return notifier
        .dispatch({
          dedupeKey: alert.dedupeKey,
          keyboard: rendered.keyboard,
          kind: "stuck",
          runId: alert.run.id,
          taskId: alert.task.id,
          text: rendered.text,
          workspaceId: alert.task.workspaceId,
        })
        .pipe(Effect.asVoid, Effect.ignoreCause);
    };

    return { announce } as const;
  })
);
