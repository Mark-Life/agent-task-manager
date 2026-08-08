import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { Toaster } from "@workspace/ui/components/sonner";
import { TooltipProvider } from "@workspace/ui/components/tooltip";
import { ThemeProvider } from "@/components/theme";
import { queryClient } from "@/lib/query-client";
import { router } from "@/router";

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
 * the screen that raised it.
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
      <Toaster />
    </QueryClientProvider>
  </ThemeProvider>
);

export default App;
