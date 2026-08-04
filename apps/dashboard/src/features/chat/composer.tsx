import { SentIcon, StopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ThreadId } from "@workspace/domain";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@workspace/ui/components/input-group";
import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useState,
} from "react";
import { usePostMessage, useStopThread } from "@/api/threads";

/**
 * What a failed send means, in the reader's terms. Only the failures this
 * endpoint declares are named; anything else is a transport fault, which reads
 * the same to whoever is looking at the screen: it did not go through.
 */
const FAILURE_TEXT: Record<string, string> = {
  InvalidInput: "The server refused the message.",
  NotFound: "This conversation no longer exists.",
};

/** A sentence for a failure, or null when there was none. Callers render the null as nothing. */
const failureText = (error: { readonly _tag: string } | null | undefined) => {
  if (error === null || error === undefined) {
    return null;
  }
  return FAILURE_TEXT[error._tag] ?? "That did not go through.";
};

interface ComposerProps {
  /** A turn is running, which is what makes a new message a queued one. */
  readonly isTurnRunning: boolean;
  readonly threadId: ThreadId;
}

/**
 * Saying something to the manager, and the one control that changes what
 * happens next.
 *
 * A message posted while a turn is running is not held anywhere: it is unread
 * until the next turn, which reads it with everything else that arrived. That
 * is a wait of unknown length, so the queued notice comes with the way out —
 * stopping the live turn closes it as interrupted and the turn that follows
 * starts by reading what was just said.
 */
export const Composer = ({ isTurnRunning, threadId }: ComposerProps) => {
  const [body, setBody] = useState("");
  const post = usePostMessage();
  const stop = useStopThread();
  const { mutate: postMessage } = post;
  const { mutate: stopTurn } = stop;

  const clear = useCallback(() => setBody(""), []);

  const onChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setBody(event.target.value);
  }, []);

  const send = useCallback(() => {
    const text = body.trim();
    if (text === "") {
      return;
    }
    postMessage({ body: text, threadId }, { onSuccess: clear });
  }, [body, clear, postMessage, threadId]);

  /**
   * Enter sends and shift-Enter breaks the line, which is what every chat box
   * this replaces does.
   */
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.shiftKey) {
        return;
      }
      event.preventDefault();
      send();
    },
    [send]
  );

  /**
   * Stopping is an intent on a queue, not an act: the row that comes back is
   * still waiting to be claimed, so it says nothing about the outcome. What
   * happened shows up as the turn state on the next poll, which is why nothing
   * here reports on the answer.
   */
  const stopLiveTurn = useCallback(() => {
    stopTurn(threadId);
  }, [stopTurn, threadId]);

  const isQueued = post.data?.queued === true && isTurnRunning;
  const failure = failureText(post.error) ?? failureText(stop.error);

  return (
    <div className="flex flex-col gap-2 border-border border-t p-4">
      {isQueued ? (
        <p className="text-muted-foreground text-xs">
          Queued. The running turn will not see it — the next one reads it with
          anything else that arrives. Stop the turn to have it answered now.
        </p>
      ) : null}
      {failure === null ? null : (
        <p className="text-destructive text-xs">{failure}</p>
      )}
      <InputGroup>
        <InputGroupTextarea
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder="Message the manager"
          rows={3}
          value={body}
        />
        <InputGroupAddon align="block-end">
          {isTurnRunning ? (
            <InputGroupButton
              disabled={stop.isPending}
              onClick={stopLiveTurn}
              variant="outline"
            >
              <HugeiconsIcon icon={StopIcon} strokeWidth={2} />
              Stop turn
            </InputGroupButton>
          ) : null}
          <InputGroupButton
            className="ml-auto"
            disabled={post.isPending || body.trim() === ""}
            onClick={send}
            variant="default"
          >
            <HugeiconsIcon icon={SentIcon} strokeWidth={2} />
            Send
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
};
