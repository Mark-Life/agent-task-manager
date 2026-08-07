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

/** Placeholder rows while the list is first read. Ids only exist to key them. */
const PENDING_ROWS = ["first", "second", "third"] as const;

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
  const { mutate: createThread } = create;

  const startConversation = useCallback(() => {
    createThread(
      {},
      { onSuccess: (thread: Thread) => onOpenThread(thread.id) }
    );
  }, [createThread, onOpenThread]);

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
        <SidebarGroupAction
          aria-label="New conversation"
          className="static shrink-0"
          disabled={create.isPending}
          onClick={startConversation}
          title="New conversation"
        >
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
        </SidebarGroupAction>
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
            disabled={create.isPending}
            onClick={startConversation}
            tooltip="New conversation"
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
        <span className="flex-1 truncate">{label}</span>
        {thread.isCurrent ? (
          <span className="text-[0.625rem] text-muted-foreground">current</span>
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
