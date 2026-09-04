/**
 * A run, read as the conversation it was.
 *
 * The same events the table gets, arranged the way the run actually happened:
 * what the model said and did in its own lane, everything that happened *to* the
 * run centred between the lanes, and a tool call drawn together with the result
 * it got. `buildChatPlan` decides the shape; this file only maps nodes to
 * components — and each frame is chosen by the same exhaustive match over the
 * payload union the table uses, so a twelfth kind of event is a compile error
 * here rather than a gap in somebody's reading of what an agent did.
 *
 * Nothing here parses markdown or highlights code itself: both come from the one
 * shared renderer in `@workspace/ui/components/markdown`, which carries a single
 * highlighter for the whole app.
 */
import type { RunEvent } from "@workspace/api";
import { RunEventPayload } from "@workspace/domain";
import { Badge } from "@workspace/ui/components/badge";
import { Markdown } from "@workspace/ui/components/markdown";
import type { ReactNode } from "react";
import { memo, useMemo } from "react";
import {
  ChatAside,
  ChatBand,
  ChatCard,
  ChatMessage,
  ChatNotes,
  Clamped,
  Facts,
} from "@/features/task/chat-parts";
import {
  buildChatPlan,
  type ChatNode,
  chatNodeKey,
  type ToolCallEvent,
  type ToolResultEvent,
} from "@/features/task/run-chat";
import {
  sameEventCluster,
  sameEventRow,
  sameToolPair,
} from "@/features/task/run-row";
import {
  formatAbsolute,
  formatCost,
  formatDuration,
  formatTokens,
} from "@/lib/format";

/**
 * Off-screen nodes skip layout.
 *
 * A run is long, mostly unread, and every message in it is a parsed markdown
 * document — laying all of them out on arrival is what would make this reading
 * slower than the one it replaces. The intrinsic size is a guess at a short
 * bubble, which is what most nodes are.
 */
const NODE = "[content-visibility:auto] [contain-intrinsic-size:auto_4rem]";

/** Just the wall-clock time: a timeline already says what day it is. */
const timeOf = (event: RunEvent) =>
  formatAbsolute(event.occurredAt, {
    dateStyle: undefined,
    timeStyle: "medium",
  });

/** How much of a message was cut before it was stored, when any of it was. */
const clipOf = (said: {
  readonly chars: number;
  readonly originalChars?: number;
  readonly truncated?: boolean;
}) =>
  said.truncated === true
    ? `clipped from ${said.originalChars ?? said.chars} chars`
    : null;

/** Whether a tool answered, in the one word a reader scans for. */
const Outcome = ({ ok }: { readonly ok: boolean }) => (
  <span className={ok ? "text-muted-foreground" : "text-destructive"}>
    {ok ? "ok" : "failed"}
  </span>
);

/** The line a tool card opens with: what was run, and roughly what it was. */
const ToolHeading = ({
  name,
  summary,
  time,
}: {
  readonly name: string;
  readonly summary: string;
  readonly time: string;
}) => (
  <>
    <span className="font-medium">{name}</span>
    <span className="min-w-0 flex-1 truncate text-muted-foreground">
      {summary}
    </span>
    <span className="shrink-0 text-muted-foreground">{time}</span>
  </>
);

/**
 * What came back, under whatever heading the caller gives it.
 *
 * The output size is kept beside the summary rather than folded into it: the
 * summary is a clip and the figure is the whole, and a reader deciding whether
 * the transcript on disk is worth opening is deciding on the figure.
 */
const ToolAnswer = ({
  children,
  outputChars,
  summary,
}: {
  readonly children: ReactNode;
  readonly outputChars: number;
  readonly summary: string;
}) => (
  <>
    <div className="flex flex-wrap items-baseline gap-2">
      {children}
      <span className="ml-auto shrink-0 text-muted-foreground">
        {outputChars} chars out
      </span>
    </div>
    <Clamped chars={summary.length}>
      <p className="whitespace-pre-wrap text-muted-foreground">{summary}</p>
    </Clamped>
  </>
);

/**
 * One event, in the frame its kind reads best in.
 *
 * Exhaustive over the union the domain declares. The eleven kinds land in four
 * frames: what the model said is a bubble, what it thought is a quiet strip, a
 * tool half with nobody to pair with is a card that says so, and everything that
 * happened to the run is a centred band. Text arrives already clipped by the
 * ingest, and every frame that draws text shows the clip rather than hiding it.
 */
const EventBody = ({ event }: { readonly event: RunEvent }) =>
  RunEventPayload.match(event.payload, {
    assistant_message: (said) => (
      <ChatMessage
        author="Agent"
        lane="agent"
        meta={
          <>
            <span>{timeOf(event)}</span>
            <Facts items={[clipOf(said)]} />
          </>
        }
      >
        <Clamped chars={said.text.length}>
          <Markdown>{said.text}</Markdown>
        </Clamped>
      </ChatMessage>
    ),

    error: (problem) => (
      <ChatBand tone="danger">
        <span className="whitespace-pre-wrap">
          {problem.errorClass}: {problem.errorMessage}
        </span>
      </ChatBand>
    ),

    failed: (crash) => (
      <ChatBand tone="danger">
        <span className="whitespace-pre-wrap">
          {crash.errorClass}: {crash.errorMessage}
          {crash.exitCode === null ? null : ` (exit ${crash.exitCode})`}
        </span>
      </ChatBand>
    ),

    finished: (done) => (
      <ChatBand>
        <Facts
          items={[
            `finished ${done.outcome}`,
            formatDuration(done.durationMs),
            `${formatTokens(done.totalTokens)} tokens`,
            `${done.turns} turns`,
            formatCost(done.costUsd),
          ]}
        />
      </ChatBand>
    ),

    // Narration, drawn bare: the cluster around it is the frame, because a run
    // writes these in bursts and one rule across the page per line says nothing
    // except that a line was written.
    log: (line) => (
      <p className={line.level === "error" ? "text-destructive" : undefined}>
        {line.message}
      </p>
    ),

    reasoning: (thought) => (
      <ChatAside>
        <span>thought</span>
        <Facts items={[`${thought.chars} chars`, timeOf(event)]} />
      </ChatAside>
    ),

    started: (start) => (
      <ChatBand>
        <Facts
          items={[
            "started",
            start.provider,
            start.model,
            start.sandboxImage,
            `${start.promptChars} chars of prompt`,
          ]}
        />
      </ChatBand>
    ),

    stopped: (kill) => (
      <ChatBand>
        <Facts
          items={["stopped", `asked for by the ${kill.requestedByKind}`]}
        />
      </ChatBand>
    ),

    // A call nobody answered. Either the run is still working on it, or it died
    // holding it — which is the thing somebody reading a stuck run came for, so
    // it is said in words rather than left as a card that merely looks short.
    tool_call: (call) => (
      <ChatCard
        header={
          <ToolHeading
            name={call.toolName}
            summary={call.summary}
            time={timeOf(event)}
          />
        }
      >
        <p className="text-muted-foreground italic">
          No result recorded for this call.
        </p>
      </ChatCard>
    ),

    // The other half of the same story: a result whose call is not on screen —
    // it may be a page back, or it may never have been written.
    tool_result: (result) => (
      <ChatCard failed={!result.ok}>
        <ToolAnswer outputChars={result.outputChars} summary={result.summary}>
          <Badge variant="outline">result only</Badge>
          <Outcome ok={result.ok} />
          <span className="text-muted-foreground">{timeOf(event)}</span>
        </ToolAnswer>
      </ChatCard>
    ),

    usage: (reading) => (
      <ChatBand>
        <Facts
          items={[
            `${formatTokens(reading.inputTokens)} in`,
            `${formatTokens(reading.outputTokens)} out`,
            `${reading.turns} turns`,
            formatCost(reading.costUsd),
            reading.rateLimitPct === null
              ? null
              : `${Math.round(reading.rateLimitPct)}% of the rate limit`,
          ]}
        />
      </ChatBand>
    ),
  });

/**
 * A call and the result it got, as one card.
 *
 * The single biggest readability win over the line-per-event reading: two lines
 * that only a shared call id related are one thing a person can read. The two
 * character counts stay two counts — summing them would invent a figure the run
 * never recorded.
 */
const ToolPairBody = ({
  call,
  result,
}: {
  readonly call: ToolCallEvent;
  readonly result: ToolResultEvent;
}) => (
  <ChatCard
    failed={!result.payload.ok}
    header={
      <ToolHeading
        name={call.payload.toolName}
        summary={call.payload.summary}
        time={timeOf(call)}
      />
    }
  >
    <ToolAnswer
      outputChars={result.payload.outputChars}
      summary={result.payload.summary}
    >
      <Outcome ok={result.payload.ok} />
      <span className="text-muted-foreground">
        {call.payload.inputChars} chars in
      </span>
    </ToolAnswer>
  </ChatCard>
);

/** One card, redrawn only when one of its halves changes. */
const ToolPair = memo(ToolPairBody, sameToolPair);

/** One event's frame, redrawn only when what it draws changes. */
const SingleEvent = memo(EventBody, sameEventRow);

/** A burst of narration as one centred block. */
const NotesBody = ({ events }: { readonly events: readonly RunEvent[] }) => (
  <ChatNotes>
    {events.map((event) => (
      <EventBody event={event} key={event.id} />
    ))}
  </ChatNotes>
);

const Notes = memo(NotesBody, sameEventCluster);

/** One node of the plan. Split out of the map so the switch stays readable. */
const renderNode = (node: ChatNode) => {
  if (node.type === "notes") {
    return <Notes events={node.events} />;
  }
  if (node.type === "pair") {
    return <ToolPair call={node.call} result={node.result} />;
  }
  return <SingleEvent event={node.event} />;
};

/**
 * The run as a conversation.
 *
 * The plan is rebuilt only when the events change, and every node is keyed by
 * an event id rather than by its position — so a page of events arriving under a
 * reader appends to the bottom instead of renumbering everything above it and
 * throwing away whatever they had open.
 */
export const RunChat = ({
  events,
}: {
  readonly events: readonly RunEvent[];
}) => {
  const plan = useMemo(() => buildChatPlan(events), [events]);

  return (
    <div className="flex flex-col gap-3" data-testid="run-chat">
      {plan.map((node) => (
        <div className={NODE} key={chatNodeKey(node)}>
          {renderNode(node)}
        </div>
      ))}
    </div>
  );
};
