import { Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@workspace/ui/components/button";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import { type ReactNode, useCallback } from "react";
import { ShortcutHint } from "@/components/shortcut";
import { useHotkey } from "@/lib/hotkey";

/**
 * Where the chosen theme is remembered.
 *
 * The pre-paint script in `index.html` reads this same key before React exists,
 * which is what stops a dark-mode reload from flashing white. The two must stay
 * spelled the same; nothing enforces it at compile time.
 *
 * Three states live under this one key. Absent, or anything that is not one of
 * the two literals, means follow the operating system; `light` and `dark` are
 * overrides. `next-themes` writes the string `system` for the follow case
 * rather than clearing the key — `setTheme` is a plain `setItem` — so both
 * readers have to treat that string as "no override". Deleting it ourselves
 * would not stick: the library's own `storage` listener sees the removal in
 * every other tab and writes the default straight back.
 */
export const THEME_STORAGE_KEY = "theme";

/**
 * No override — the state the app starts in and the one a press hands back to,
 * spelled the way `next-themes` spells it.
 */
const FOLLOW_SYSTEM = "system";

/**
 * Theme state for the whole app.
 *
 * `attribute="class"` is not a preference: the shared stylesheet defines its
 * dark palette under a `.dark` selector, so a provider writing a data attribute
 * instead would leave every dark value unreachable. Transitions are suppressed
 * across the switch so a theme change is a cut rather than a slow wipe of every
 * colour on screen.
 *
 * The keyboard shortcut is mounted here rather than beside the button, so it
 * covers the sign-in screen too — that page is outside the shell, and the
 * toggle is a piece of the shell's footer.
 */
export const ThemeProvider = ({ children }: { children: ReactNode }) => (
  <NextThemesProvider
    attribute="class"
    defaultTheme={FOLLOW_SYSTEM}
    disableTransitionOnChange
    enableColorScheme
    enableSystem
    storageKey={THEME_STORAGE_KEY}
  >
    <ThemeHotkey />
    {children}
  </NextThemesProvider>
);

/**
 * What one press stores, given what is on screen and what the machine asks for.
 *
 * Two states on screen, three in the model. The press always moves to the
 * opposite of what is currently rendered — that is the whole of what a reader
 * has to predict — but when the opposite is what the operating system is
 * already asking for, the override is dropped instead of being written the
 * other way round. So a machine sitting in light mode alternates between an
 * explicit `dark` and following the system, and every second press hands
 * control back rather than pinning the app to a literal forever.
 *
 * The system preference is read here, which is to say only on a press. If the
 * machine switches to dark in the evening while an override is stored, the
 * override stands: somebody asked for this theme, and a wallpaper schedule is
 * not them changing their mind. That case is why this is not simply "clear the
 * override if there is one" — the two would agree until the machine changed
 * under a stored override, and then clearing would leave the screen exactly as
 * it was and the press would look broken.
 */
export const nextTheme = ({
  resolved,
  system,
}: {
  readonly resolved: string | undefined;
  readonly system: string | undefined;
}) => {
  const opposite = resolved === "dark" ? "light" : "dark";
  return opposite === system ? FOLLOW_SYSTEM : opposite;
};

/** One press of the theme control, wherever it came from. */
const useToggleTheme = () => {
  const { resolvedTheme, setTheme, systemTheme } = useTheme();

  return useCallback(() => {
    setTheme(nextTheme({ resolved: resolvedTheme, system: systemTheme }));
  }, [resolvedTheme, setTheme, systemTheme]);
};

/** The letter that flips the theme from anywhere. */
const TOGGLE_KEY = "d";

/**
 * Renders nothing; the shortcut is the whole of it.
 *
 * A component rather than a call inside `ThemeProvider`, because the provider
 * is what supplies the theme context and a hook reading that context cannot run
 * in the same component that provides it.
 */
const ThemeHotkey = () => {
  const toggle = useToggleTheme();
  useHotkey(TOGGLE_KEY, toggle);
  return null;
};

/**
 * Flips between light and dark.
 *
 * Both icons are rendered and CSS picks one, rather than the component asking
 * which theme resolved: the resolved value is unknown on the first client
 * render, and branching on it produces a button whose icon visibly corrects
 * itself a frame later. The pre-paint script has already put `.dark` on the
 * document by then, so the right one is showing before this component knows
 * which it is.
 *
 * The button has no visible label — two icons and nothing else — so the
 * `aria-label` stays where it was and the tooltip only describes. The letter is
 * announced in the tooltip rather than in a `title`, which the browser draws in
 * its own box after a pause and never draws at all on a touch screen.
 */
export const ModeToggle = () => {
  const toggle = useToggleTheme();

  return (
    <ShortcutHint hotkey={TOGGLE_KEY} label="Toggle theme">
      <Button
        aria-label="Toggle theme"
        onClick={toggle}
        size="icon"
        variant="ghost"
      >
        <HugeiconsIcon
          className="dark:hidden"
          icon={Sun03Icon}
          strokeWidth={2}
        />
        <HugeiconsIcon
          className="hidden dark:block"
          icon={Moon02Icon}
          strokeWidth={2}
        />
      </Button>
    </ShortcutHint>
  );
};
