import { Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@workspace/ui/components/button";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import { type ReactNode, useCallback } from "react";

/**
 * Where the chosen theme is remembered.
 *
 * The pre-paint script in `index.html` reads this same key before React exists,
 * which is what stops a dark-mode reload from flashing white. The two must stay
 * spelled the same; nothing enforces it at compile time.
 */
export const THEME_STORAGE_KEY = "theme";

/**
 * Theme state for the whole app.
 *
 * `attribute="class"` is not a preference: the shared stylesheet defines its
 * dark palette under a `.dark` selector, so a provider writing a data attribute
 * instead would leave every dark value unreachable. Transitions are suppressed
 * across the switch so a theme change is a cut rather than a slow wipe of every
 * colour on screen.
 */
export const ThemeProvider = ({ children }: { children: ReactNode }) => (
  <NextThemesProvider
    attribute="class"
    defaultTheme="system"
    disableTransitionOnChange
    enableColorScheme
    enableSystem
    storageKey={THEME_STORAGE_KEY}
  >
    {children}
  </NextThemesProvider>
);

/**
 * Flips between light and dark.
 *
 * Both icons are rendered and CSS picks one, rather than the component asking
 * which theme resolved: the resolved value is unknown on the first client
 * render, and branching on it produces a button whose icon visibly corrects
 * itself a frame later.
 */
export const ModeToggle = () => {
  const { resolvedTheme, setTheme } = useTheme();

  const toggle = useCallback(() => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setTheme]);

  return (
    <Button
      aria-label="Toggle theme"
      onClick={toggle}
      size="icon"
      title="Toggle theme"
      variant="ghost"
    >
      <HugeiconsIcon className="dark:hidden" icon={Sun03Icon} strokeWidth={2} />
      <HugeiconsIcon
        className="hidden dark:block"
        icon={Moon02Icon}
        strokeWidth={2}
      />
    </Button>
  );
};
