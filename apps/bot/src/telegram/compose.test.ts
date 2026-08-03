/**
 * Compose has two halves worth pinning, and they fail in different ways.
 *
 * The buffer is where a message goes missing: held under the wrong chat, added
 * to a session that was already sent, kept forever after the person walked
 * away, or dropped because the write behind *Send* failed. Each of those is a
 * test below, because the symptom of every one of them is the same silence.
 *
 * The rendering is where the manager stops being able to tell one message from
 * the next. The order has to be Telegram's rather than this process's — a voice
 * note finishes transcribing after the sentence typed behind it — and a batch of
 * exactly one has to come out indistinguishable from the message sent without
 * compose, because that is the promise `/compose` around a single message makes.
 */

import { describe, expect, test } from "bun:test";
import {
  COMPOSE_IDLE_MS,
  type ComposePiece,
  composedBody,
  composePieceLabel,
  composeRow,
  makeComposeBuffers,
} from "./compose";

const CHAT = 4242;
const OTHER_CHAT = -100_123;
const ANCHOR = 77;
const NOW = 1_700_000_000_000;

/** A held message with only the fields the buffer and the rendering read. */
const piece = (fields: Partial<ComposePiece>): ComposePiece => ({
  body: "something",
  forwardFrom: null,
  intakeKind: "text",
  telegramMessageId: 1,
  transcriptChars: null,
  ...fields,
});

const text = (body: string, telegramMessageId: number) =>
  piece({ body, telegramMessageId });

const forward = (input: {
  body: string;
  from: string;
  telegramMessageId: number;
}) =>
  piece({
    body: input.body,
    forwardFrom: input.from,
    intakeKind: "forward",
    telegramMessageId: input.telegramMessageId,
  });

const voice = (body: string, telegramMessageId: number) =>
  piece({
    body,
    intakeKind: "voice",
    telegramMessageId,
    transcriptChars: body.length,
  });

/** A chat that is composing, with nothing held yet. */
const opened = () => {
  const buffers = makeComposeBuffers();
  buffers.open({ anchorMessageId: ANCHOR, chatId: CHAT, now: NOW });
  return buffers;
};

describe("makeComposeBuffers", () => {
  test("a chat that never composed is idle", () => {
    expect(makeComposeBuffers().peek({ chatId: CHAT, now: NOW })).toEqual({
      kind: "idle",
    });
  });

  test("opening a buffer makes the chat composing, holding nothing", () => {
    const state = opened().peek({ chatId: CHAT, now: NOW });

    expect(state.kind).toBe("composing");
    expect(state.kind === "composing" && state.session.pieces).toEqual([]);
    expect(state.kind === "composing" && state.session.anchorMessageId).toBe(
      ANCHOR
    );
  });

  test("held messages come back in the order Telegram numbered them", () => {
    const buffers = opened();
    // The slow one arrives last and belongs first: a voice note is transcribed
    // while the sentence typed behind it is already resolved.
    buffers.add({ chatId: CHAT, now: NOW, piece: text("second", 11) });
    const held = buffers.add({
      chatId: CHAT,
      now: NOW,
      piece: voice("first", 10),
    });

    expect(held?.pieces.map((entry) => entry.body)).toEqual([
      "first",
      "second",
    ]);
  });

  test("one chat's buffer is not another's", () => {
    const buffers = opened();
    buffers.add({ chatId: CHAT, now: NOW, piece: text("mine", 1) });

    expect(buffers.peek({ chatId: OTHER_CHAT, now: NOW })).toEqual({
      kind: "idle",
    });
    expect(
      buffers.add({ chatId: OTHER_CHAT, now: NOW, piece: text("x", 2) })
    ).toBeNull();
  });

  test("closing answers what was held and leaves the chat idle", () => {
    const buffers = opened();
    buffers.add({ chatId: CHAT, now: NOW, piece: text("held", 1) });

    expect(buffers.close(CHAT)?.pieces).toHaveLength(1);
    expect(buffers.peek({ chatId: CHAT, now: NOW })).toEqual({ kind: "idle" });
    expect(buffers.close(CHAT)).toBeNull();
  });

  test("a message that lands after the send is not held", () => {
    // The window is real: the tap closes the buffer while a voice note sent
    // before it is still being transcribed. Null is what tells the router to
    // store it the ordinary way rather than drop it.
    const buffers = opened();
    buffers.close(CHAT);

    expect(
      buffers.add({ chatId: CHAT, now: NOW, piece: text("late", 1) })
    ).toBeNull();
  });

  test("a session nobody added to goes stale, once, and says so", () => {
    const buffers = opened();
    buffers.add({ chatId: CHAT, now: NOW, piece: text("yesterday", 1) });
    const later = NOW + COMPOSE_IDLE_MS + 1;

    const state = buffers.peek({ chatId: CHAT, now: later });
    expect(state.kind).toBe("expired");
    expect(state.kind === "expired" && state.session.pieces).toHaveLength(1);
    // Expired is reported to whoever looked first and then forgotten, so the
    // next message is an ordinary message rather than a second apology.
    expect(buffers.peek({ chatId: CHAT, now: later })).toEqual({
      kind: "idle",
    });
  });

  test("every message pushes the idle window out", () => {
    const buffers = opened();
    const nearly = NOW + COMPOSE_IDLE_MS - 1;
    buffers.add({ chatId: CHAT, now: nearly, piece: text("still here", 1) });

    expect(
      buffers.peek({ chatId: CHAT, now: nearly + COMPOSE_IDLE_MS - 1 }).kind
    ).toBe("composing");
  });

  test("a second /compose moves the anchor and keeps the words", () => {
    const buffers = opened();
    buffers.add({ chatId: CHAT, now: NOW, piece: text("kept", 1) });

    const displaced = buffers.open({
      anchorMessageId: ANCHOR + 9,
      chatId: CHAT,
      now: NOW,
    });

    expect(displaced?.anchorMessageId).toBe(ANCHOR);
    const state = buffers.peek({ chatId: CHAT, now: NOW });
    expect(state.kind === "composing" && state.session.anchorMessageId).toBe(
      ANCHOR + 9
    );
    expect(state.kind === "composing" && state.session.pieces).toHaveLength(1);
  });

  test("restoring a failed send puts the words back, with anything held since", () => {
    const buffers = opened();
    buffers.add({ chatId: CHAT, now: NOW, piece: text("first", 1) });
    const session = buffers.close(CHAT);
    if (session === null) {
      throw new Error("nothing to restore");
    }
    // The chat kept talking while the write was failing.
    buffers.open({ anchorMessageId: ANCHOR, chatId: CHAT, now: NOW });
    buffers.add({ chatId: CHAT, now: NOW, piece: text("second", 2) });

    buffers.restore({ chatId: CHAT, now: NOW, session });

    const state = buffers.peek({ chatId: CHAT, now: NOW });
    expect(
      state.kind === "composing" &&
        state.session.pieces.map((entry) => entry.body)
    ).toEqual(["first", "second"]);
  });
});

describe("composePieceLabel", () => {
  test("a plain message is numbered and nothing more", () => {
    expect(
      composePieceLabel({ index: 0, piece: text("hi", 1), total: 3 })
    ).toBe("[message 1 of 3]");
  });

  test("a forward keeps the name it came from", () => {
    expect(
      composePieceLabel({
        index: 1,
        piece: forward({ body: "look", from: "Ada", telegramMessageId: 2 }),
        total: 3,
      })
    ).toBe("[message 2 of 3 · forwarded from Ada]");
  });

  test("a forward from somebody Telegram would not name still says it was one", () => {
    expect(
      composePieceLabel({
        index: 0,
        piece: piece({ intakeKind: "forward" }),
        total: 1,
      })
    ).toBe("[message 1 of 1 · forwarded from someone]");
  });

  test("a voice note says the words were dictated", () => {
    expect(
      composePieceLabel({ index: 2, piece: voice("um so", 3), total: 3 })
    ).toBe("[message 3 of 3 · voice note, transcribed]");
  });
});

describe("composedBody", () => {
  test("every piece is headed, in order, with a blank line between", () => {
    expect(
      composedBody([
        text("first thing", 1),
        forward({ body: "her words", from: "Ada", telegramMessageId: 2 }),
        voice("the third point", 3),
      ])
    ).toBe(
      [
        "[message 1 of 3]",
        "first thing",
        "",
        "[message 2 of 3 · forwarded from Ada]",
        "her words",
        "",
        "[message 3 of 3 · voice note, transcribed]",
        "the third point",
      ].join("\n")
    );
  });
});

describe("composeRow", () => {
  test("one held message is stored as though it had been sent alone", () => {
    const only = forward({ body: "look", from: "Ada", telegramMessageId: 2 });

    expect(composeRow([only])).toEqual({
      body: "look",
      forwardFrom: "Ada",
      intakeKind: "forward",
      transcriptChars: null,
    });
  });

  test("a voice note held alone keeps the length of what was heard", () => {
    expect(composeRow([voice("said out loud", 1)])).toEqual({
      body: "said out loud",
      forwardFrom: null,
      intakeKind: "voice",
      transcriptChars: "said out loud".length,
    });
  });

  test("several become one compose row carrying all of them", () => {
    const row = composeRow([text("one", 1), voice("two", 2)]);

    expect(row.intakeKind).toBe("compose");
    // The per-message columns cannot describe a batch, so they say nothing
    // rather than describing one of its pieces.
    expect(row.forwardFrom).toBeNull();
    expect(row.transcriptChars).toBeNull();
    expect(row.body).toContain("one");
    expect(row.body).toContain("two");
  });
});
