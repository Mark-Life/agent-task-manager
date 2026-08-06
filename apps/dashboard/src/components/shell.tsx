import {
  FolderLibraryIcon,
  KanbanIcon,
  Key01Icon,
  Logout01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Avatar, AvatarFallback } from "@workspace/ui/components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
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
} from "@workspace/ui/components/sidebar";
import { type ReactNode, useCallback } from "react";
import { signOut, useSession } from "@/auth/client";
import { WorkspacePicker } from "@/auth/workspace";
import { ModeToggle } from "@/components/theme";

/** Where signing out lands, and the one page the shell never wraps. */
const SIGN_IN_PATH = "/login";

/**
 * The whole of the navigation. The board is the work, projects are where it
 * belongs, and keys are how anything that is not this dashboard reaches either.
 * Conversations are not here — they open over whatever is underneath rather
 * than replacing it, so they are a list further down and never a page of their
 * own.
 */
const DESTINATIONS = [
  { icon: KanbanIcon, label: "Board", to: "/" },
  { icon: FolderLibraryIcon, label: "Projects", to: "/projects" },
  { icon: Key01Icon, label: "API keys", to: "/api-keys" },
] as const;

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
              className="h-9"
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
          <span className="truncate">{name}</span>
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

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <div className="group-data-[collapsible=icon]:hidden">
            <WorkspacePicker />
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              {DESTINATIONS.map((destination) => (
                <SidebarMenuItem key={destination.to}>
                  <SidebarMenuButton
                    isActive={isCurrent(pathname, destination.to)}
                    render={<Link to={destination.to} />}
                    tooltip={destination.label}
                  >
                    <HugeiconsIcon icon={destination.icon} strokeWidth={2} />
                    <span>{destination.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>

          {conversations}
        </SidebarContent>

        <SidebarFooter>
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
        <header className="flex h-12 shrink-0 items-center gap-2 px-3">
          <SidebarTrigger />
        </header>
        <div className="min-h-0 min-w-0 flex-1">
          <Outlet />
        </div>
      </SidebarInset>
      {children}
    </SidebarProvider>
  );
};
