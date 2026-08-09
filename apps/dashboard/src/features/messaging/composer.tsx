import { SentIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@workspace/ui/components/button";
import { Textarea } from "@workspace/ui/components/textarea";
import { cn } from "@workspace/ui/lib/utils";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useState,
} from "react";
import { useUpdateHold } from "@/pwa/hold";

/** What a caller is handed when the box is sent: the text, and the way to empty it. */
export interface ComposerSend {
  readonly body: string;
  /** Call once the write has landed. Until then the text stays, so a refusal loses nothing. */
  readonly sent: () => void;
}

interface MessageComposerProps {
  /** Controls that belong beside Send — stopping a running turn, and nothing else so far. */
  readonly actions?: ReactNode;
  readonly className?: string;
  /** Whatever went wrong with the last attempt, already in the reader's terms. */
  readonly error?: string | null;
  readonly isPending?: boolean;
  /** A line above the box about what sending now will mean. */
  readonly notice?: ReactNode;
  readonly onSend: (input: ComposerSend) => void;
  readonly placeholder: string;
}

/**
 * The box at the foot of a conversation.
 *
 * One component for both conversations the operator can be in — with the
 * manager in the sidebar, and with whatever is working on a task — because the
 * only difference between them is where the text is posted. Enter sends and
 * shift-Enter breaks the line, which is what every chat box this replaces does;
 * a two-line message is the common one, and reaching for the mouse to post it
 * is the tax on writing it at all.
 *
 * The draft lives here and the write does not: the caller keeps its own
 * mutation and calls `sent` when the server has taken the message, which is
 * what keeps a failed send from clearing what was typed.
 */
export const MessageComposer = ({
  actions,
  className,
  error,
  isPending = false,
  notice,
  onSend,
  placeholder,
}: MessageComposerProps) => {
  const [body, setBody] = useState("");

  // The draft lives here and nowhere else, so a reload is the one thing that
  // can lose it. The app updates itself in the background; this is what keeps
  // it from doing so over a half-written message.
  useUpdateHold(body.trim() !== "", "a message is half written");

  const onChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setBody(event.target.value);
  }, []);

  const clear = useCallback(() => setBody(""), []);

  const send = useCallback(() => {
    const text = body.trim();
    if (text === "") {
      return;
    }
    onSend({ body: text, sent: clear });
  }, [body, clear, onSend]);

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

  return (
    // The foot of the panel is the box, not a box inside the foot: one top
    // border against the conversation, and the panel's own edges on the other
    // three sides. A framed field sitting in a padded footer would be two
    // nested surfaces saying the same thing.
    <div
      className={cn(
        "flex shrink-0 flex-col border-border border-t bg-input/20 dark:bg-input/30",
        className
      )}
    >
      {notice === undefined ? null : (
        <p className="px-3 pt-2 text-muted-foreground text-xs">{notice}</p>
      )}
      {error === null || error === undefined ? null : (
        <p className="px-3 pt-2 text-destructive text-xs">{error}</p>
      )}
      <Textarea
        className="min-h-14 rounded-none border-0 bg-transparent px-3 pt-2.5 pb-1 focus-visible:border-0 focus-visible:ring-0 md:text-[0.8125rem]/relaxed dark:bg-transparent"
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={2}
        value={body}
      />
      <div className="flex items-center gap-2 px-3 pb-2.5">
        {actions}
        {/* A round mark rather than a labelled button: it sits under a box
            that says what it is for, and Enter sends anyway. */}
        <Button
          aria-label="Send"
          className="ml-auto rounded-full"
          disabled={isPending || body.trim() === ""}
          onClick={send}
          size="icon-lg"
        >
          <HugeiconsIcon icon={SentIcon} strokeWidth={2} />
        </Button>
      </div>
    </div>
  );
};
