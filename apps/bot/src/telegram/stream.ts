/**
 * A turn, rendered into a chat while it is still running.
 *
 * The renderer consumes the normalized agent events a turn produces and decides
 * which of them a person sees, in which form, and which survive the turn.
 *
 * **What is permanent and what is not.** An assistant message is what the
 * person asked for; it is sent as a rich markdown message and stays in the
 * chat. Tool calls and reasoning are *progress* — worth watching while the turn
 * runs, worthless afterwards — so they go out as Telegram drafts, which expire
 * on their own after half a minute and leave no scrollback. That is the whole
 * reason drafts exist, and it is what keeps a forty-tool turn from burying its
 * own answer under a wall of `Read: src/index.ts`.
 *
 * Drafts are private-chat only, so `isPrivateChat: false` degrades to the
 * assistant messages alone rather than failing. A group gets a quieter turn,
 * not a broken one.
 *
 * **The last message waits.** Each assistant message is held until something
 * follows it, so the final one can carry the footer — cost, duration, tokens —
 * in the same bubble instead of a second message that says only `$0.03`. In
 * practice the wait is the length of one tool call, or nothing at all on a
 * text-only turn.
 *
 * **Nothing here is shared between turns.** Every piece of state lives in one
 * `Ref` created with the renderer, so two threads streaming at once cannot see
 * each other's tool lines — the failure mode of a bot written for one user.
 *
 * **Economics are recorded, never invented.** The `result` event's fields are
 * copied as they arrive, nulls included. A turn that reported no cost renders a
 * footer without a cost, not a footer claiming zero.
 */

import type { AgentEvent } from "@workspace/harness";
import { Effect, Ref, Schedule } from "effect";
import type { Api } from "grammy";
import { toTelegramApiError } from "./errors";
import {
  formatFooter,
  renderReasoning,
  renderToolLines,
  type TurnEconomics,
} from "./format";
import { DEFAULT_SPLIT_AT, sendText, TELEGRAM_MAX_MESSAGE_CHARS } from "./send";

/** How often a draft may be rewritten. Telegram rate limits edits per chat. */
export const DEFAULT_DRAFT_INTERVAL_MS = 300;

/** How often the "typing…" action is renewed. Telegram clears it after five seconds. */
const TYPING_INTERVAL_MS = 5000;

/** Tool lines kept in the live draft. Older ones scroll out of a preview anyway. */
const MAX_DRAFT_TOOL_LINES = 12;

/** A rich message body: model text as raw markdown, bot chrome as Telegram HTML. */
type RichInput = { readonly markdown: string } | { readonly html: string };

/** Which kind of progress the current draft slot is showing. */
type DraftPhase = "none" | "reasoning" | "tools";

/** What one rendered turn produced, in the shape the caller's row wants. */
export interface StreamResult {
  readonly costUsd: number | null;
  readonly durationMs: number | null;
  /** Set by an in-stream `error` event or by the terminus; null on a clean turn. */
  readonly errorClass: string | null;
  readonly errorMessage: string | null;
  /** The last message this renderer sent, for `chat_message.telegram_message_id`. */
  readonly lastMessageId: number | null;
  readonly providerSessionId: string | null;
  /** Every assistant message of the turn, joined — what the thread's history stores. */
  readonly text: string;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly totalTokens: number | null;
  readonly turns: number | null;
}

/** Everything the renderer mutates, in one place, per turn. */
interface RenderState {
  readonly costUsd: number | null;
  readonly draftPhase: DraftPhase;
  readonly draftSeq: number;
  readonly durationMs: number | null;
  readonly errorClass: string | null;
  readonly errorMessage: string | null;
  readonly lastDraftAt: number;
  readonly lastMessageId: number | null;
  readonly pendingText: string | null;
  readonly providerSessionId: string | null;
  readonly reasoningChars: number;
  readonly sentText: readonly string[];
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly toolLines: readonly string[];
  readonly totalTokens: number | null;
  readonly turns: number | null;
}

/** The state a fresh turn starts from. */
const initialState = (): RenderState => ({
  costUsd: null,
  draftPhase: "none",
  draftSeq: 0,
  durationMs: null,
  errorClass: null,
  errorMessage: null,
  lastDraftAt: 0,
  lastMessageId: null,
  pendingText: null,
  providerSessionId: null,
  reasoningChars: 0,
  sentText: [],
  toolCalls: 0,
  toolErrors: 0,
  toolLines: [],
  totalTokens: null,
  turns: null,
});

/** The tail of the tool lines, as the draft shows them. */
const draftToolLines = (lines: readonly string[]) =>
  lines.slice(Math.max(0, lines.length - MAX_DRAFT_TOOL_LINES));

/** One tool call, as a line a person can read. */
const toolLineOf = (event: Extract<AgentEvent, { kind: "tool_call" }>) =>
  event.summary.length === 0
    ? event.toolName
    : `${event.toolName}: ${event.summary}`;

/**
 * Build a renderer for one turn.
 *
 * Scoped: the typing-indicator fiber is forked into the caller's scope and dies
 * with it, so a turn that is interrupted stops claiming to be typing.
 */
export const makeChatRenderer = Effect.fnUntraced(function* (options: {
  readonly api: Api;
  readonly chatId: number;
  readonly draftIntervalMs?: number;
  readonly isPrivateChat: boolean;
  readonly replyToMessageId?: number | null;
  readonly splitAt?: number;
}) {
  const {
    api,
    chatId,
    draftIntervalMs = DEFAULT_DRAFT_INTERVAL_MS,
    isPrivateChat,
    replyToMessageId = null,
    splitAt = DEFAULT_SPLIT_AT,
  } = options;
  const state = yield* Ref.make(initialState());

  /** The typing action, renewed until the scope closes. */
  const typing = Effect.tryPromise({
    catch: (cause) => toTelegramApiError({ cause, method: "sendChatAction" }),
    try: () => api.sendChatAction(chatId, "typing"),
  }).pipe(Effect.ignore);
  yield* typing;
  yield* Effect.forkScoped(
    typing.pipe(Effect.repeat(Schedule.spaced(TYPING_INTERVAL_MS)))
  );

  /**
   * Overwrite the current draft slot. Best-effort by construction: a draft is a
   * preview, and a preview that failed to render changes nothing about the turn.
   */
  const putDraft = (input: RichInput) =>
    isPrivateChat
      ? Ref.get(state).pipe(
          Effect.flatMap((current) =>
            Effect.tryPromise({
              catch: (cause) =>
                toTelegramApiError({ cause, method: "sendRichMessageDraft" }),
              try: () =>
                api.sendRichMessageDraft(chatId, current.draftSeq, input),
            })
          ),
          Effect.ignore
        )
      : Effect.void;

  /**
   * Persist a rich message, falling back to plain text when Telegram will not
   * take the markup. The fallback is the difference between a person seeing the
   * answer with odd punctuation and not seeing it at all.
   */
  const putMessage = Effect.fnUntraced(function* (body: string) {
    const sent = yield* Effect.tryPromise({
      catch: (cause) =>
        toTelegramApiError({ cause, method: "sendRichMessage" }),
      try: () => api.sendRichMessage(chatId, { markdown: body }),
    }).pipe(Effect.option);
    if (sent._tag === "Some") {
      yield* Ref.update(state, (s) => ({
        ...s,
        lastMessageId: sent.value.message_id,
      }));
      return;
    }
    const fallback = yield* sendText({
      api,
      chatId,
      send:
        replyToMessageId === null
          ? {}
          : { reply_parameters: { message_id: replyToMessageId } },
      splitAt,
      text: body.length === 0 ? "…" : body,
    }).pipe(Effect.orElseSucceed(() => []));
    const last = fallback.at(-1);
    if (last !== undefined) {
      yield* Ref.update(state, (s) => ({
        ...s,
        lastMessageId: last.message_id,
      }));
    }
  });

  /** Move to a fresh draft slot so a new phase renders as its own preview. */
  const advanceDraft = (phase: DraftPhase) =>
    Ref.update(state, (s) => ({
      ...s,
      draftPhase: phase,
      draftSeq: s.draftSeq + 1,
      lastDraftAt: 0,
    }));

  /** Whether the draft was rewritten too recently to rewrite again. */
  const throttled = Effect.fnUntraced(function* () {
    const now = Date.now();
    const current = yield* Ref.get(state);
    if (now - current.lastDraftAt < draftIntervalMs) {
      return true;
    }
    yield* Ref.update(state, (s) => ({ ...s, lastDraftAt: now }));
    return false;
  });

  /** Persist whatever assistant text is being held, with an optional footer. */
  const flushPending = Effect.fnUntraced(function* (footer: string) {
    const current = yield* Ref.get(state);
    if (current.pendingText === null) {
      return;
    }
    const body =
      footer.length === 0
        ? current.pendingText
        : `${current.pendingText}\n\n${footer}`;
    yield* Ref.update(state, (s) => ({ ...s, pendingText: null }));
    const chunks =
      body.length > TELEGRAM_MAX_MESSAGE_CHARS
        ? [body.slice(0, splitAt), body.slice(splitAt)]
        : [body];
    for (const chunk of chunks) {
      yield* putMessage(chunk);
    }
  });

  /** A complete assistant message: persist the previous one, hold this one. */
  const onAssistantText = Effect.fnUntraced(function* (text: string) {
    yield* flushPending("");
    yield* Ref.update(
      state,
      (s): RenderState => ({
        ...s,
        draftPhase: "none",
        pendingText: text,
        sentText: [...s.sentText, text],
      })
    );
  });

  /** A tool call: count it, and show the tail of the trace in the draft. */
  const onToolCall = Effect.fnUntraced(function* (line: string) {
    const current = yield* Ref.get(state);
    if (current.draftPhase !== "tools") {
      yield* advanceDraft("tools");
    }
    yield* Ref.update(state, (s) => ({
      ...s,
      toolCalls: s.toolCalls + 1,
      toolLines: [...s.toolLines, line],
    }));
    if (yield* throttled()) {
      return;
    }
    const updated = yield* Ref.get(state);
    yield* putDraft({
      html: renderToolLines(draftToolLines(updated.toolLines)).html,
    });
  });

  /** Reasoning is measured and shown as a count. The text itself never leaves the turn. */
  const onReasoning = Effect.fnUntraced(function* (chars: number) {
    const current = yield* Ref.get(state);
    if (current.draftPhase !== "reasoning") {
      yield* advanceDraft("reasoning");
    }
    yield* Ref.update(state, (s) => ({
      ...s,
      reasoningChars: s.reasoningChars + chars,
    }));
    if (yield* throttled()) {
      return;
    }
    const updated = yield* Ref.get(state);
    yield* putDraft({
      html: renderReasoning({
        maxChars: TELEGRAM_MAX_MESSAGE_CHARS,
        text: `Thinking… ${updated.reasoningChars} characters`,
      }).html,
    });
  });

  /** The terminus: copy the economics as reported, nulls included. */
  const onResult = Effect.fnUntraced(function* (
    event: Extract<AgentEvent, { kind: "result" }>
  ) {
    yield* Ref.update(state, (s) => ({
      ...s,
      costUsd: event.costUsd === null ? null : Number(event.costUsd),
      durationMs: event.durationMs,
      errorClass: event.errorClass ?? s.errorClass,
      errorMessage: event.errorMessage ?? s.errorMessage,
      providerSessionId: event.providerSessionId ?? s.providerSessionId,
      totalTokens: event.totalTokens,
      turns: event.turns,
    }));
    const current = yield* Ref.get(state);
    if (event.text.length > 0 && current.sentText.length === 0) {
      yield* onAssistantText(event.text);
    }
  });

  /**
   * Feed one event to the renderer.
   *
   * `usage` and `log` are deliberately absent: a mid-turn token reading is not
   * something a person in a chat can act on, and the harness's own narration
   * belongs in the log, not in somebody's messages.
   */
  const push = Effect.fnUntraced(function* (event: AgentEvent) {
    switch (event.kind) {
      case "assistant_text":
        yield* onAssistantText(event.text);
        break;
      case "tool_call":
        yield* onToolCall(toolLineOf(event));
        break;
      case "tool_result":
        if (!event.ok) {
          yield* Ref.update(state, (s) => ({
            ...s,
            toolErrors: s.toolErrors + 1,
          }));
        }
        break;
      case "reasoning":
        yield* onReasoning(event.chars);
        break;
      case "session_init":
        yield* Ref.update(state, (s) => ({
          ...s,
          providerSessionId: event.providerSessionId,
        }));
        break;
      case "error":
        yield* Ref.update(state, (s) => ({
          ...s,
          errorClass: event.errorClass,
          errorMessage: event.errorMessage,
        }));
        break;
      case "result":
        yield* onResult(event);
        break;
      default:
        break;
    }
  });

  /**
   * End the turn: persist the held message with its footer and report what the
   * turn produced. Safe to call on every exit path, including an interrupted
   * one — a turn stopped mid-sentence still shows what it had said.
   */
  const finish = Effect.fnUntraced(function* () {
    const current = yield* Ref.get(state);
    const economics: TurnEconomics = {
      costUsd: current.costUsd,
      durationMs: current.durationMs,
      totalTokens: current.totalTokens,
      turns: current.turns,
    };
    yield* flushPending(formatFooter(economics));
    const final = yield* Ref.get(state);
    return {
      costUsd: final.costUsd,
      durationMs: final.durationMs,
      errorClass: final.errorClass,
      errorMessage: final.errorMessage,
      lastMessageId: final.lastMessageId,
      providerSessionId: final.providerSessionId,
      text: final.sentText.join("\n\n"),
      toolCalls: final.toolCalls,
      toolErrors: final.toolErrors,
      totalTokens: final.totalTokens,
      turns: final.turns,
    } satisfies StreamResult;
  });

  return { finish, push } as const;
});

/** A renderer for one turn, derived so a consumer cannot restate its surface. */
export type ChatRenderer = Effect.Success<ReturnType<typeof makeChatRenderer>>;
