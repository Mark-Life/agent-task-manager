import {
  Archive02Icon,
  MoreHorizontalIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { Thread } from "@workspace/api";
import type { ThreadId } from "@workspace/domain";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@workspace/ui/components/sidebar";
import { useCallback } from "react";
import { threadsQuery, useCreateThread, usePatchThread } from "@/api/threads";
import { ShortcutHint, ShortcutLabel } from "@/components/shortcut";
import { useHotkey, useHotkeys } from "@/lib/hotkey";

/** Placeholder rows while the list is first read. Ids only exist to key them. */
const PENDING_ROWS = ["first", "second", "third"] as const;

/** The letter that starts a conversation, wherever the operator is. */
const NEW_KEY = "n";

/**
 * The digits that open one, against the order the list is drawn in.
 *
 * Positional and nothing more: 1 is whatever sits at the top at the moment it
 * is pressed. Starting a conversation puts a row above the rest and moves every
 * number down one, so a digit names a place in the list rather than a thread —
 * nothing here remembers that some conversation was once 3. Nine because that
 * is where the row of digits ends; a digit past the end of the list opens
 * nothing rather than wrapping or opening the last.
 */
const POSITION_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

interface ThreadListProps {
  /** The conversation the overlay is open on, so the row reads as selected. */
  readonly activeThreadId: ThreadId | null;
  /** Hands routing back to the layout: it puts the id in the search param. */
  readonly onOpenThread: (threadId: ThreadId) => void;
}

/**
 * The manager conversations, as a section of the left sidebar.
 *
 * The list lives beside navigation rather than behind a route because a
 * conversation is opened over whatever is on screen, so it has to be reachable
 * without leaving the board. Archived threads are absent: retiring one keeps it
 * for the audit rows that point at it, and there is no delete anywhere.
 */
export const ThreadList = ({
  activeThreadId,
  onOpenThread,
}: ThreadListProps) => {
  const threads = useQuery(threadsQuery({ status: "active" }));
  const create = useCreateThread();
  const { isPending: isCreating, mutate: createThread } = create;

  // The buttons below are disabled while a create is in flight; the shortcut
  // has no disabled state, so it checks the same flag. Without it a second
  // press before the first answer opens one conversation and leaves another
  // behind it.
  const startConversation = useCallback(() => {
    if (isCreating) {
      return;
    }
    createThread(
      {},
      { onSuccess: (thread: Thread) => onOpenThread(thread.id) }
    );
  }, [createThread, isCreating, onOpenThread]);

  const openByPosition = useCallback(
    (key: string) => {
      const thread = threads.data?.[Number(key) - 1];
      if (thread !== undefined) {
        onOpenThread(thread.id);
      }
    },
    [onOpenThread, threads.data]
  );

  // Both bound on the list rather than on the controls it draws, which is what
  // makes them work with the sidebar collapsed to the rail: the rail keeps one
  // button and no rows, and the keys are about the conversations, not about
  // what is on screen.
  useHotkey(NEW_KEY, startConversation);
  useHotkeys(POSITION_KEYS, openByPosition);

  return (
    <SidebarGroup>
      {/*
        An explicit heading row rather than the sidebar's absolutely
        positioned group action: the button shares the "Conversations" line
        instead of floating over the group's corner, where it read as a
        column of its own. The whole row goes away when the sidebar
        collapses, because the label means nothing at icon width.
      */}
      <div className="flex items-center gap-1 group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel className="flex-1">Conversations</SidebarGroupLabel>
        {/*
          A plus and no words, so the name stays on the `aria-label` and the
          tooltip carries the letter as well. It replaces a native `title`,
          which said the same thing a second later and in the browser's own box.
        */}
        <ShortcutHint hotkey={NEW_KEY} label="New conversation">
          <SidebarGroupAction
            aria-label="New conversation"
            className="static shrink-0"
            disabled={isCreating}
            onClick={startConversation}
          >
            <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
          </SidebarGroupAction>
        </ShortcutHint>
      </div>
      <SidebarGroupContent className="group-data-[collapsible=icon]:hidden">
        <SidebarMenu>
          {threads.isPending
            ? PENDING_ROWS.map((row) => (
                <SidebarMenuItem key={row}>
                  <SidebarMenuSkeleton />
                </SidebarMenuItem>
              ))
            : null}
          {threads.data?.map((thread) => (
            <ThreadRow
              isActive={thread.id === activeThreadId}
              key={thread.id}
              onOpenThread={onOpenThread}
              thread={thread}
            />
          ))}
        </SidebarMenu>
        {threads.data?.length === 0 ? (
          <p className="px-2 py-1.5 text-muted-foreground text-xs">
            No conversations yet.
          </p>
        ) : null}
      </SidebarGroupContent>
      {/*
        The collapsed rail's one control. Listing conversations there renders
        each title as a lone first letter, so the rail only offers starting a
        new one; opening a conversation stays a job for the expanded list.
      */}
      <SidebarMenu className="hidden group-data-[collapsible=icon]:flex">
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-label="New conversation"
            disabled={isCreating}
            onClick={startConversation}
            tooltip={{
              children: (
                <ShortcutLabel hotkey={NEW_KEY} label="New conversation" />
              ),
            }}
          >
            <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
            <span>New conversation</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
};

interface ThreadRowProps {
  readonly isActive: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly thread: Thread;
}

/**
 * One conversation in the list.
 *
 * A row is a component of its own so each one owns its handlers rather than
 * building them inside a loop. Currency is shown but is not what selecting a
 * row does: the current thread is the one Telegram speaks to, and reading a
 * conversation here should not silently redirect the bot.
 */
const ThreadRow = ({ isActive, onOpenThread, thread }: ThreadRowProps) => {
  const patch = usePatchThread();
  const { mutate: patchThread } = patch;

  const open = useCallback(() => {
    onOpenThread(thread.id);
  }, [onOpenThread, thread.id]);

  const makeCurrent = useCallback(() => {
    patchThread({ patch: { isCurrent: true }, threadId: thread.id });
  }, [patchThread, thread.id]);

  const archive = useCallback(() => {
    patchThread({ patch: { status: "archived" }, threadId: thread.id });
  }, [patchThread, thread.id]);

  const label = thread.title ?? "New conversation";

  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={isActive} onClick={open} tooltip={label}>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {/* The badge keeps its size and the title gives way, rather than the two splitting the row and a long title pushing the badge off the end. */}
        {thread.isCurrent ? (
          <span className="shrink-0 text-[0.625rem] text-muted-foreground">
            current
          </span>
        ) : null}
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger render={<SidebarMenuAction showOnHover />}>
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
          <span className="sr-only">Conversation actions</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          <DropdownMenuItem
            disabled={thread.isCurrent || patch.isPending}
            onClick={makeCurrent}
          >
            Make current
          </DropdownMenuItem>
          <DropdownMenuItem disabled={patch.isPending} onClick={archive}>
            <HugeiconsIcon icon={Archive02Icon} strokeWidth={2} />
            Archive
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
};
