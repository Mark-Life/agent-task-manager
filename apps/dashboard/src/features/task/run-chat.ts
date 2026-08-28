/**
 * Turning a run's event stream into a chat script.
 *
 * The conversation reading is a second reading of the same events the table
 * gets, so every shaping decision — which lane an event sits in, which call owns
 * which result, which neighbours cluster, where a body clamps — lives here as a
 * pure function rather than inside JSX. The renderer then only maps nodes to
 * components, and a wrong lane or a lost result is a unit-test failure instead
 * of something somebody has to spot by eye in a two-thousand-event run.
 */
import type { RunEvent } from "@workspace/api";
import type { RunEventKind, RunEventPayload } from "@workspace/domain";

/**
 * Which column an event reads in.
 *
 * `user` is here and unreachable from a run: the event stream is what the
 * container did, and the person who asked for it left no turn in it — the
 * prompt arrives as a character count on `started` and nothing else. The lane
 * exists because these same shapes are what the Sessions transcript will mount
 * when the gateway can answer for it, and that stream does carry a human turn.
 */
export type ChatLane = "agent" | "center" | "user";

/**
 * The shape one event takes in the conversation.
 *
 * Separate from the lane because two shapes can share a lane and read nothing
 * alike: a message and a tool card are both the model working, and a band and a
 * note are both centred.
 */
export type ChatShape =
  | "band"
  | "call"
  | "message"
  | "note"
  | "result"
  | "thinking";

/**
 * What each kind of event becomes.
 *
 * Exhaustive over the kinds the domain declares, which is what makes a twelfth
 * kind of event a compile error here rather than an event that quietly renders
 * as nothing. The two views are exhaustive in their own right; this is the
 * table that decides which of their frames each kind is drawn in.
 */
const SHAPES = {
  assistant_message: "message",
  error: "band",
  failed: "band",
  finished: "band",
  log: "note",
  reasoning: "thinking",
  started: "band",
  stopped: "band",
  tool_call: "call",
  tool_result: "result",
  usage: "band",
} as const satisfies Record<RunEventKind, ChatShape>;

/** Which lane each shape is drawn in. */
const LANES = {
  band: "center",
  call: "agent",
  message: "agent",
  note: "center",
  result: "agent",
  thinking: "agent",
} as const satisfies Record<ChatShape, ChatLane>;

/** The shape one event takes. */
export const shapeOf = (event: RunEvent): ChatShape =>
  SHAPES[event.payload.kind];

/** Which side of the conversation an event belongs to. */
export const laneOf = (event: RunEvent): ChatLane => LANES[shapeOf(event)];

/**
 * Body length past which a block is clamped to a fixed height behind a fade.
 *
 * Counted in characters rather than in rendered lines, so one very long
 * unwrapped line clamps the same as many short ones. The ingest already holds a
 * message to sixteen kilobytes, which is still around two hundred lines — far
 * more than the reader scrolling past it asked for.
 */
export const CLAMP_CHARS = 800;

/** Whether a body is long enough to need the clamp and its "Show all". */
export const needsClamp = (chars: number) => chars > CLAMP_CHARS;

/** A run of adjacent events, never empty — the head is what a key is taken from. */
type NonEmpty = readonly [RunEvent, ...RunEvent[]];

/** An event already narrowed to the payload its kind carries. */
type EventOf<K extends RunEventKind> = RunEvent & {
  readonly payload: Extract<RunEventPayload, { readonly kind: K }>;
};

/** A tool invocation, with its call id in reach. */
export type ToolCallEvent = EventOf<"tool_call">;

/** What a tool gave back. */
export type ToolResultEvent = EventOf<"tool_result">;

const isCall = (event: RunEvent): event is ToolCallEvent =>
  event.payload.kind === "tool_call";

const isResult = (event: RunEvent): event is ToolResultEvent =>
  event.payload.kind === "tool_result";

/**
 * One thing the chat draws.
 *
 * Three shapes rather than one per kind: a call that found its result, a burst
 * of narration, and everything else on its own. Which frame a lone event is
 * drawn in — a bubble, a quiet strip, a centred band, a card with a missing
 * half — is the renderer's business, and it settles it by the same exhaustive
 * match the table does. A pair carries both halves because a card with only one
 * of them is not a pair; that case is a `single`, and it is one of the things a
 * reader opens a stuck run to find.
 */
export type ChatNode =
  | { readonly type: "notes"; readonly events: NonEmpty }
  | {
      readonly type: "pair";
      readonly call: ToolCallEvent;
      readonly result: ToolResultEvent;
    }
  | { readonly type: "single"; readonly event: RunEvent };

/**
 * The result that answers `call`, searched forward through the events actually
 * on screen.
 *
 * Forward only, and by the call id the harness wrote: a result that has not been
 * paged in yet simply leaves its call unanswered, which is the honest reading —
 * a call whose result never arrived is exactly what somebody reading a stuck run
 * is hunting for.
 */
const resultFor = (
  events: readonly RunEvent[],
  from: number,
  callId: string
): ToolResultEvent | null => {
  for (let i = from; i < events.length; i += 1) {
    const event = events[i];
    if (
      event !== undefined &&
      isResult(event) &&
      event.payload.callId === callId
    ) {
      return event;
    }
  }
  return null;
};

/**
 * One forward pass over the events, in the order the container wrote them.
 *
 * Two things happen in it: every tool call takes the result that answers it into
 * one card, and adjacent log lines gather into one cluster. A run narrates in
 * bursts — six lines about pulling an image, then nothing for a minute — and six
 * centred bands in a row bury the conversation they are supposed to annotate.
 */
export const buildChatPlan = (
  events: readonly RunEvent[]
): readonly ChatNode[] => {
  const nodes: ChatNode[] = [];
  const paired = new Set<RunEvent>();
  let notes: RunEvent[] = [];

  const flush = () => {
    const [head, ...rest] = notes;
    if (head !== undefined) {
      nodes.push({ events: [head, ...rest], type: "notes" });
      notes = [];
    }
  };

  for (const [index, event] of events.entries()) {
    // Already drawn inside somebody else's card. Deliberately not a flush: a
    // result folded into a call is not on screen between two log lines, so it
    // does not break the cluster they would otherwise form.
    if (paired.has(event)) {
      continue;
    }
    const shape = shapeOf(event);
    if (shape === "note") {
      notes.push(event);
      continue;
    }
    flush();
    // Narrowed rather than read off the shape: pairing needs the call id the
    // harness wrote, and only the narrowed payload carries one.
    if (isCall(event)) {
      const result = resultFor(events, index + 1, event.payload.callId);
      if (result !== null) {
        paired.add(result);
        nodes.push({ call: event, result, type: "pair" });
        continue;
      }
    }
    nodes.push({ event, type: "single" });
  }
  flush();
  return nodes;
};

/**
 * The React key for a node.
 *
 * Taken from an event id rather than from the node's position, so appending a
 * page of events to a live run does not renumber the nodes above it — which is
 * what would throw away every open card and the reader's place with them.
 */
export const chatNodeKey = (node: ChatNode): string => {
  if (node.type === "notes") {
    return node.events[0].id;
  }
  return node.type === "pair" ? node.call.id : node.event.id;
};
