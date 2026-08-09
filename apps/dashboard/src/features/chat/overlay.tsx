import type { ThreadId } from "@workspace/domain";
import { Sheet, SheetContent } from "@workspace/ui/components/sheet";
import { lazy, Suspense } from "react";
import { Pending } from "@/components/query-state";

/**
 * The conversation itself, fetched the first time one is opened.
 *
 * This panel is mounted on every authenticated screen and shows nothing until
 * the URL names a thread, so what it would otherwise carry — the transcript,
 * the markdown parser and the syntax highlighter under it — is loaded on the
 * open rather than on the way to the board.
 */
const Conversation = lazy(() =>
  import("@/features/chat/conversation").then((module) => ({
    default: module.Conversation,
  }))
);

interface ChatOverlayProps {
  /** Called with `false` when the panel closes; the layout drops the search param. */
  readonly onOpenChange: (open: boolean) => void;
  /** The conversation to show, or null for no overlay at all. */
  readonly threadId: ThreadId | null;
}

/**
 * A conversation with the manager, over whatever is on screen.
 *
 * A side panel rather than a centred dialog: a conversation is read top to
 * bottom and needs the full height of the window, and the screen underneath
 * stays mounted behind it rather than being navigated away from, so closing the
 * panel puts the reader back where they were. Opening and closing are the
 * caller's, so the panel's visibility is a fact about the URL and a link to one
 * conversation can be sent to someone.
 *
 * The width is spelled as `data-[side=right]:` variants because the primitive
 * caps a right-hand panel with variants of its own, which a plainer class loses
 * to. The name sits on the panel rather than only in its header: the header's
 * title arrives with the thread, and the dialog is announced before that.
 */
export const ChatOverlay = ({ onOpenChange, threadId }: ChatOverlayProps) => (
  <Sheet onOpenChange={onOpenChange} open={threadId !== null}>
    <SheetContent
      aria-label="Conversation"
      className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl data-[side=right]:lg:max-w-2xl"
      side="right"
    >
      {threadId === null ? null : (
        // The same skeleton the thread's own messages arrive behind, so waiting
        // for the panel's code and waiting for its contents look alike.
        <Suspense
          fallback={<Pending className="p-4" label="Opening conversation" />}
        >
          <Conversation threadId={threadId} />
        </Suspense>
      )}
    </SheetContent>
  </Sheet>
);
