import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { TooltipProvider } from "@workspace/ui/components/tooltip";
import { lazy, Suspense } from "react";
import { ThemeProvider } from "@/components/theme";
import { queryClient } from "@/lib/query-client";
import { router } from "@/router";

/**
 * The toaster, fetched after the app is on screen.
 *
 * Nothing raises a toast yet — no call site in this app or in the component
 * package asks for one — so mounting it eagerly spent the notification library
 * on every first load to render an empty region. Behind `lazy` it costs nothing
 * until the browser is idle enough to fetch it, and the first `toast()` somebody
 * writes still lands in a toaster that is already mounted.
 */
const Toaster = lazy(() =>
  import("@workspace/ui/components/sonner").then((module) => ({
    default: module.Toaster,
  }))
);

/**
 * How long a pointer has to rest on a control before its hint appears.
 *
 * The package's own default is none at all, which turns a mouse crossing the
 * sidebar into a run of tooltips. Long enough to read as deliberate, and well
 * short of the second or so a native `title` takes — these hints carry the
 * keyboard shortcuts, and a hint nobody waits for teaches nobody anything.
 */
const TOOLTIP_DELAY_MS = 400;

/**
 * The provider stack, in the only order that works.
 *
 * The theme is outermost because everything below reads the resolved theme —
 * including the toaster, which picks its own palette from that hook. The cache
 * sits above the router so routes and the components they render share one
 * client, and the router is innermost since it is what renders the app. The
 * toaster is a sibling of the router rather than a child, so a message outlives
 * the screen that raised it. It has nothing to fall back to while it loads —
 * a toaster with no toasts in it draws nothing anyway.
 *
 * Tooltips are provided here rather than beside any one control: the delay is a
 * property of the app, and a `Tooltip` without a provider above it falls back to
 * the library's own timing, so two hints on the same screen would behave
 * differently depending on who mounted them.
 */
const App = () => (
  <ThemeProvider>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delay={TOOLTIP_DELAY_MS}>
        <RouterProvider router={router} />
      </TooltipProvider>
      <Suspense fallback={null}>
        <Toaster />
      </Suspense>
    </QueryClientProvider>
  </ThemeProvider>
);

export default App;
