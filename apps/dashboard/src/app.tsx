import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { Toaster } from "@workspace/ui/components/sonner";
import { ThemeProvider } from "@/components/theme";
import { queryClient } from "@/lib/query-client";
import { router } from "@/router";

/**
 * The provider stack, in the only order that works.
 *
 * The theme is outermost because everything below reads the resolved theme —
 * including the toaster, which picks its own palette from that hook. The cache
 * sits above the router so routes and the components they render share one
 * client, and the router is innermost since it is what renders the app. The
 * toaster is a sibling of the router rather than a child, so a message outlives
 * the screen that raised it.
 */
const App = () => (
  <ThemeProvider>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  </ThemeProvider>
);

export default App;
