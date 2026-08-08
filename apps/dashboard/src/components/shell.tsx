import {
  FolderLibraryIcon,
  KanbanIcon,
  Key01Icon,
  Logout01Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { Avatar, AvatarFallback } from "@workspace/ui/components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import { Kbd } from "@workspace/ui/components/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@workspace/ui/components/sidebar";
import { type ReactNode, useCallback, useEffect } from "react";
import { signOut, useSession } from "@/auth/client";
import { WorkspacePicker } from "@/auth/workspace";
import { ShortcutLabel } from "@/components/shortcut";
import { ModeToggle } from "@/components/theme";
import { UsageMeters } from "@/features/usage/meters";
import { useHotkeys } from "@/lib/hotkey";

/** Where signing out lands, and the one page the shell never wraps. */
const SIGN_IN_PATH = "/login";

/**
 * The whole of the navigation. The board is the work, projects are where it
 * belongs, and keys are how anything that is not this dashboard reaches either.
 * Conversations are not here — they open over whatever is underneath rather
 * than replacing it, so they are a list further down and never a page of their
 * own.
 *
 * Each one carries the letter that reaches it, so the taken letters are read
 * off one list rather than hunted for: `d` flips the theme, `f` opens the
 * board's search, `t` its new-task panel, `n` starts a conversation and the
 * digits open one, and a fourth destination would have to find a letter none of
 * those has spoken for. `k` rather than `a` for the keys, because it is the word
 * the page is called by.
 */
const DESTINATIONS = [
  { hotkey: "b", icon: KanbanIcon, label: "Board", to: "/" },
  { hotkey: "p", icon: FolderLibraryIcon, label: "Projects", to: "/projects" },
  { hotkey: "k", icon: Key01Icon, label: "API keys", to: "/api-keys" },
] as const;

/** The bound letters, in the order they are listed above. */
const DESTINATION_KEYS = DESTINATIONS.map((destination) => destination.hotkey);

/**
 * Where a letter leads, or null when it leads nowhere.
 *
 * Separate from the component so the mapping can be read and tested as the
 * plain lookup it is: a letter that is not one of these is not this shell's to
 * answer, and saying so with null keeps the caller's decision explicit.
 */
export const destinationFor = (key: string) =>
  DESTINATIONS.find((destination) => destination.hotkey === key) ?? null;

/**
 * Whether a destination is the one being looked at. The board owns the root
 * path exactly — everything else lives beneath its own prefix, so a task page
 * still highlights the board it came from.
 */
const isCurrent = (pathname: string, to: string) =>
  to === "/" ? pathname === "/" : pathname.startsWith(to);

/** Whatever separates the parts of a name or an email address. */
const NAME_PARTS = /[\s@._-]+/;

/** Two letters off whatever the account is called, which is all an avatar holds. */
const initialsOf = (name: string) =>
  name
    .split(NAME_PARTS)
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

/**
 * Shuts the mobile sidebar once the route changes.
 *
 * On a narrow screen the sidebar is a sheet over the page, not a column next
 * to it, so tapping a destination swaps the page underneath while the sheet
 * stays up and hides it. Watching the pathname catches navigation from the
 * conversation list as well as from the destination menu, which a per-link
 * click handler would miss. The desktop collapse state is a different flag and
 * stays as it was.
 */
const CloseMobileSidebarOnRouteChange = ({
  pathname,
}: {
  readonly pathname: string;
}) => {
  const { setOpenMobile } = useSidebar();
  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);
  return null;
};

/**
 * Who is signed in, and the way out.
 *
 * Signing out is a full page load rather than a route change: the session
 * cookie is gone, so every cache entry, every open subscription and the
 * router's own state are about a person who is no longer here, and throwing the
 * document away is the only way to be sure none of it survives.
 */
const AccountMenu = () => {
  const queryClient = useQueryClient();
  const { data } = useSession();

  // A refusal comes back in the body rather than as a thrown error, so it has
  // to be rethrown to reach the mutation. Resolving on a refusal would clear
  // the cache and show the sign-in form while the cookie is still live, which
  // is the one outcome a person walking away from the screen must not get.
  const leave = useMutation({
    mutationFn: async () => {
      const { error } = await signOut();
      if (error) {
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.clear();
      window.location.assign(SIGN_IN_PATH);
    },
  });

  const { mutate } = leave;
  const signOutNow = useCallback(() => mutate(), [mutate]);

  const name = data?.user.name ?? data?.user.email ?? "Signed in";
  const email = data?.user.email ?? "";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuButton
              className="h-9 group-data-[collapsible=icon]:justify-center"
              size="lg"
              tooltip={email === "" ? name : email}
            />
          }
        >
          <Avatar className="size-5 rounded-md">
            <AvatarFallback className="rounded-md text-[10px]">
              {initialsOf(name)}
            </AvatarFallback>
          </Avatar>
          {/*
            The rail is one avatar wide; the name only fits while the
            sidebar is open. The tooltip still carries it when collapsed.
          */}
          <span className="truncate group-data-[collapsible=icon]:hidden">
            {name}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-48" side="top">
          {email === "" ? null : (
            <div className="truncate px-2 py-1.5 text-muted-foreground text-xs">
              {email}
            </div>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={leave.isPending} onClick={signOutNow}>
            <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/*
        Outside the menu on purpose: clicking the item closes the popup and the
        portal unmounts with it, so a message rendered in there would be gone
        before the request came back.
      */}
      {leave.isError ? (
        <p className="px-2 pt-1 text-destructive text-xs">
          Sign-out did not go through. You are still signed in.
        </p>
      ) : null}
    </>
  );
};

interface ShellProps {
  /**
   * Rendered over the page rather than inside it. The conversation overlay
   * belongs to the layout, not to any one screen, so it is handed in here and
   * stays mounted while the board, a task or the project list changes beneath.
   */
  readonly children?: ReactNode;
  /**
   * The conversation list for the sidebar. Passed in rather than imported so
   * the chrome does not depend on the chat feature it merely makes room for,
   * and rendered as given: the list brings its own group heading and its own
   * "new conversation" action.
   */
  readonly conversations?: ReactNode;
}

/**
 * The frame every signed-in screen sits in.
 *
 * The sidebar carries navigation and the manager conversations together,
 * because both are ways of getting somewhere and splitting them across two
 * surfaces would only make the operator look in two places. It collapses to
 * icons rather than disappearing, so the board keeps its full width on a narrow
 * screen without the way out going with it.
 */
export const Shell = ({ children, conversations }: ShellProps) => {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  // Unbound rather than this route's own hook: the shell renders under a
  // pathless layout, so a bound `navigate` would resolve these paths against
  // the root. The navigation is the plain one a click on the row performs —
  // same target, same search handling — so the row highlights and the history
  // entry read the same whichever way the operator got there.
  const navigate = useNavigate();
  const goToDestination = useCallback(
    (key: string) => {
      const destination = destinationFor(key);
      if (destination !== null) {
        navigate({ to: destination.to });
      }
    },
    [navigate]
  );
  useHotkeys(DESTINATION_KEYS, goToDestination);

  return (
    /*
      The frame is exactly one viewport tall and never scrolls itself. The
      wrapper ships with `min-h-svh`, which is a floor and not a ceiling: a tall
      page pushes the whole document down, and every `h-full` and `min-h-0`
      beneath it resolves against a box that keeps growing, so an inner
      `overflow-auto` never has a height to scroll inside. Capping it here is
      what lets a screen decide where its own scroll lives — for the board, in
      each column, with the toolbar and the column headings staying put.
    */
    <SidebarProvider className="h-svh overflow-hidden">
      <CloseMobileSidebarOnRouteChange pathname={pathname} />
      <Sidebar collapsible="icon">
        <SidebarHeader>
          {/**
           * The desktop collapse button lives in the sidebar itself rather
           * than in a strip above the page: one row saved on every screen,
           * and the button stays reachable with the sidebar collapsed to the
           * icon rail, which is when it is most needed. The mobile sheet
           * hides it — its own close gesture serves the same turn there.
           */}
          {/*
            The product's mark and name first, then its one ambient control.
            The icon rail keeps only the trigger: the name goes with the
            words, and the rail's one job is to widen again.
          */}
          <div className="flex items-center gap-1 group-data-[collapsible=icon]:justify-center">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 group-data-[collapsible=icon]:hidden">
              <HugeiconsIcon
                className="size-4 shrink-0 text-primary"
                icon={TerminalIcon}
                strokeWidth={2}
              />
              <span className="truncate font-heading font-medium text-sm">
                Agent Task Manager
              </span>
            </div>
            <SidebarTrigger
              aria-label="Toggle sidebar"
              className="shrink-0 max-md:hidden"
            />
          </div>
          <div className="group-data-[collapsible=icon]:hidden">
            <WorkspacePicker />
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              {DESTINATIONS.map((destination) => (
                <SidebarMenuItem key={destination.to}>
                  {/*
                    The letter sits in the row while there is a row to sit in,
                    and moves into the tooltip the button already draws for the
                    collapsed rail — one hint, in whichever place is left.
                  */}
                  <SidebarMenuButton
                    isActive={isCurrent(pathname, destination.to)}
                    render={<Link to={destination.to} />}
                    tooltip={{
                      children: (
                        <ShortcutLabel
                          hotkey={destination.hotkey}
                          label={destination.label}
                        />
                      ),
                    }}
                  >
                    <HugeiconsIcon icon={destination.icon} strokeWidth={2} />
                    <span className="min-w-0 flex-1 truncate">
                      {destination.label}
                    </span>
                    {/*
                      A fill off the text colour rather than the key's own
                      `bg-muted`: in this palette `--sidebar-accent` and
                      `--muted` are the same value, so the default cap would
                      disappear on exactly the row that is current. A tint of
                      whatever is above it stays one step off both the plain row
                      and the highlighted one, in either theme.
                    */}
                    <Kbd className="shrink-0 bg-foreground/10 group-data-[collapsible=icon]:hidden">
                      {destination.hotkey.toUpperCase()}
                    </Kbd>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>

          {conversations}
        </SidebarContent>

        <SidebarFooter>
          {/*
            Imported rather than handed in like the conversation list. That one
            is a feature with routing of its own and the chrome only makes room
            for it; this is a fact about the machine the whole frame runs on,
            with no route, no selection and nothing for a screen to pass it.
          */}
          <UsageMeters />
          <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
            <div className="min-w-0 flex-1">
              <AccountMenu />
            </div>
            <ModeToggle />
          </div>
        </SidebarFooter>
      </Sidebar>

      {/*
        `min-w-0` on both the inset and the page wrapper is what keeps a wide
        page — the board's column strip above all — scrolling inside itself
        rather than stretching the document. A flex item defaults to
        `min-width: auto`, so without it the strip's own `overflow-x-auto` never
        engages and the sidebar slides off-screen with the content.
      */}
      <SidebarInset className="min-w-0">
        {/*
          No strip of its own above the page. On a narrow screen the sidebar is
          a sheet with nowhere to keep its button, so each screen draws the
          trigger at the head of its own top row — one row of vertical space
          back, which on a phone is most of what the board has to spend. On a
          desktop the trigger sits in the sidebar header instead.
        */}
        {/*
          The default scroll for a page that is simply long — the project list,
          the keys, a task. A screen that would rather scroll in pieces takes
          `h-full` on its own root, which fills this box exactly and so leaves
          nothing here to scroll.
        */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </SidebarInset>
      {children}
    </SidebarProvider>
  );
};
