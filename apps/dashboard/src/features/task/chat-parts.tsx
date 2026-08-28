/**
 * The pieces a transcript is drawn from, with nothing in them about run events.
 *
 * Two streams want this reading: the run's own event timeline, which has real
 * data today, and the Sessions transcript, which the gateway still answers 501
 * for. So the frames take a lane, a heading and a body rather than a payload,
 * and the mapping from whichever record is at hand onto them lives beside that
 * record instead of in here. Nothing below reaches for a highlighter or a
 * markdown parser of its own — callers hand in already-rendered children, drawn
 * with the one shared renderer in `@workspace/ui/components/markdown`.
 */
import { Bubble, BubbleContent } from "@workspace/ui/components/bubble";
import { Button } from "@workspace/ui/components/button";
import { Marker, MarkerContent } from "@workspace/ui/components/marker";
import {
  Message,
  MessageContent,
  MessageHeader,
} from "@workspace/ui/components/message";
import { cn } from "@workspace/ui/lib/utils";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { type ChatLane, needsClamp } from "@/features/task/run-chat";

/**
 * A row of small facts with the absent ones dropped rather than drawn as
 * blanks. Nullable economics come through here, which is why a null is nothing
 * at all and never a zero.
 */
export const Facts = ({
  items,
}: {
  readonly items: readonly (string | null)[];
}) => (
  <>
    {items
      .filter((item) => item !== null && item !== "")
      .map((item) => (
        <span key={item}>{item}</span>
      ))}
  </>
);

interface ChatMessageProps {
  /** Who is talking, in the words the reader thinks in. */
  readonly author: string;
  readonly children: ReactNode;
  readonly lane: Exclude<ChatLane, "center">;
  /** Small facts beside the name: a clock, a clip, a token count. */
  readonly meta?: ReactNode;
}

/**
 * Something that was said, in the lane of whoever said it.
 *
 * The same two-lane arrangement the manager conversation uses, and the same
 * primitives: a reader who has looked at one of this app's transcripts should
 * not have to learn a second vocabulary of bubbles to read the other.
 */
export const ChatMessage = ({
  author,
  children,
  lane,
  meta,
}: ChatMessageProps) => (
  <Message align={lane === "user" ? "end" : "start"}>
    <MessageContent>
      <MessageHeader className="gap-2">
        <span>{author}</span>
        {meta}
      </MessageHeader>
      <Bubble variant={lane === "user" ? "default" : "muted"}>
        <BubbleContent className="px-3 py-2 text-[0.8125rem]/relaxed">
          {children}
        </BubbleContent>
      </Bubble>
    </MessageContent>
  </Message>
);

/**
 * A quiet strip in the model's lane: something it did rather than something it
 * said. Deliberately narrower and dimmer than a bubble — a reader scanning for
 * what happened should be able to skip every one of these at a glance.
 */
export const ChatAside = ({ children }: { readonly children: ReactNode }) => (
  <div className="flex w-full">
    <div className="flex max-w-[85%] flex-wrap items-baseline gap-2 rounded-md border border-border border-dashed px-2.5 py-1 text-muted-foreground text-xs italic">
      {children}
    </div>
  </div>
);

/** What a band is about: the ordinary course of a run, or something wrong with it. */
export type BandTone = "danger" | "muted";

/**
 * A notice across the whole conversation: a run starting, a usage reading, a
 * crash. Centred between the lanes because it belongs to neither — nobody said
 * it, it happened.
 */
export const ChatBand = ({
  children,
  tone = "muted",
}: {
  readonly children: ReactNode;
  readonly tone?: BandTone;
}) => (
  <Marker
    className={cn(tone === "danger" && "text-destructive")}
    variant="separator"
  >
    {/*
      The separator variant sizes its content `flex-none` so the two rules
      around it take the slack, which is right for a date marker of three words
      and wrong for a band of five facts: on a phone the last of them is cut off
      the side of the screen rather than wrapped. Made shrinkable, so the rules
      give way first and the facts wrap onto a second line.
    */}
    <MarkerContent className="flex flex-wrap items-baseline justify-center gap-x-2 gap-y-0.5 group-data-[variant=separator]/marker:flex-initial">
      {children}
    </MarkerContent>
  </Marker>
);

/**
 * Narration, centred and quiet.
 *
 * A run's log lines arrive in bursts, so they are stacked as one block rather
 * than drawn as one band each: six rules across the conversation in a row say
 * nothing except that six lines were written.
 */
export const ChatNotes = ({ children }: { readonly children: ReactNode }) => (
  <div className="flex flex-col items-center gap-0.5 py-0.5 text-center text-muted-foreground text-xs">
    {children}
  </div>
);

interface ChatCardProps {
  readonly children: ReactNode;
  /** Drawn with the destructive edge: something in this card went wrong. */
  readonly failed?: boolean;
  /** The line the card opens with, when there is one to draw. */
  readonly header?: ReactNode;
}

/**
 * One bordered card in the model's lane, for a thing with two halves to it.
 *
 * Wider than a bubble on purpose: what goes in one is a command line and what
 * came back, and wrapping either of those at bubble width is how the current
 * timeline reads.
 */
export const ChatCard = ({ children, failed, header }: ChatCardProps) => (
  <div className="flex w-full">
    <div
      className={cn(
        "flex w-full min-w-0 max-w-[92%] flex-col gap-1 rounded-md border border-border px-2.5 py-2 text-xs",
        failed === true && "border-destructive/40"
      )}
    >
      {header === undefined ? null : (
        <div className="flex flex-wrap items-baseline gap-2">{header}</div>
      )}
      {children}
    </div>
  </div>
);

/** A clamped body: a fixed height behind a fade, rather than a line count — one
 *  unwrapped nine-hundred-character line would otherwise clamp to nothing. */
const CLAMPED =
  "max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]";

/**
 * A body that only takes the height it has earned.
 *
 * The decision is made on the character count the caller passes rather than on
 * whatever the children measure to, so it is the same pure rule the plan is
 * tested against. A short body gets no control at all: an affordance under every
 * one-line message is noise on a run that is mostly one-line messages.
 */
export const Clamped = ({
  chars,
  children,
}: {
  readonly chars: number;
  readonly children: ReactNode;
}) => {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((was) => !was), []);

  if (!needsClamp(chars)) {
    return children;
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <div className={cn("w-full", open ? "" : CLAMPED)}>{children}</div>
      <Button
        className="h-5 px-1 text-[0.625rem] text-muted-foreground"
        onClick={toggle}
        size="xs"
        variant="ghost"
      >
        {open ? "Show less" : "Show all"}
      </Button>
    </div>
  );
};
