/**
 * What is left in the tanks, at the bottom of the sidebar.
 *
 * The board dispatches against two subscriptions and neither has a number on it
 * anywhere else, so this is the one place a person can see the wall coming. It
 * sits in the footer rather than on a screen of its own because it is a fact
 * about the machine and not about whatever is being looked at.
 *
 * **Two renderings, one reading.** Open, the sidebar has room for both windows of
 * both providers, each as a bar with the figure and the distance to its reset;
 * the reset is not decoration, since a drained window with twenty minutes on it
 * and one that rolls over on Thursday are the same percentage and different
 * situations. Collapsed to the icon rail there is room for two hairlines, one per
 * provider, each showing that provider's *worst* window — the one that will bite
 * first — with the whole reading in a tooltip and in the trigger's accessible
 * name. The bars on the rail are marked decorative: the words are the content,
 * and a screen reader should hear the reading rather than "progressbar, 62".
 *
 * **Nothing is ever drawn as a guess.** A provider that could not be read gets a
 * sentence, and an empty document gets a sentence; neither gets a bar, because a
 * bar at zero and a bar nobody could fill look identical and mean the opposite
 * things. The colours are legibility only — what actually holds a dispatch back
 * is the state the reading carries, which is rendered as words beside the name.
 */

import { useQuery } from "@tanstack/react-query";
import { Progress } from "@workspace/ui/components/progress";
import { Skeleton } from "@workspace/ui/components/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";
import { DateTime } from "effect";
import { usageQuery } from "@/api/usage";
import { failureSentence } from "@/components/query-state";
import {
  blankUsage,
  type ProviderView,
  type UsageTone,
  type UsageView,
  usageSummary,
  usageView,
  type WindowView,
} from "@/features/usage/model";

/**
 * How each band paints its bar.
 *
 * Written out in full rather than composed, because Tailwind reads these classes
 * out of the source: a class built from a variable at runtime is a class that
 * was never generated. The scale runs the board's own way — the brand colour
 * while there is room, amber where it is worth noticing, the destructive red
 * where a run is likely to die against it.
 */
const TONE_BARS = {
  drained: "[&_[data-slot=progress-indicator]]:bg-destructive",
  healthy: "[&_[data-slot=progress-indicator]]:bg-primary",
  low: "[&_[data-slot=progress-indicator]]:bg-amber-500",
} as const satisfies Record<UsageTone, string>;

/** Everything in this panel is secondary to the board; nothing here shouts. */
const FINE_PRINT = "text-[0.625rem] leading-tight";

/** What the trigger says when the read itself never came back. */
const READ_FAILED = "The reading could not be fetched.";

/** One window's figure, as words: `5h · 62% left · resets in 42m`. */
const windowSentence = (window: WindowView) =>
  [
    `${window.label} · ${window.remainingText} left`,
    window.resetsInText === null ? null : `resets ${window.resetsInText}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");

interface BarProps {
  readonly className?: string;
  /**
   * The bar's accessible name, or null where the same facts are already carried
   * by whatever encloses it — on the rail, by the trigger's own label.
   */
  readonly label: string | null;
  readonly window: WindowView;
}

/** One window as a hairline. Remaining is what fills it, not what is spent. */
const UsageBar = ({ className, label, window }: BarProps) => (
  <Progress
    aria-hidden={label === null ? true : undefined}
    aria-label={label ?? undefined}
    className={cn("gap-0", TONE_BARS[window.tone], className)}
    value={window.remainingPercent}
  />
);

/** A window with nothing in it to draw. Empty track, never an empty bar. */
const NoBar = () => (
  <span aria-hidden="true" className="block h-1 w-full rounded-md bg-muted" />
);

/** One window's row in the open sidebar: span, bar, figure, reset. */
const WindowRow = ({
  provider,
  window,
}: {
  readonly provider: string;
  readonly window: WindowView;
}) => (
  <div className="flex items-center gap-1.5">
    {/*
      Labels are the provider's own — `5h`, `7d` — and a provider that stops
      reporting a span sends a word instead, so the column truncates rather
      than pushing the bar off the row.
    */}
    <span
      className={cn(
        "w-5 shrink-0 truncate text-muted-foreground tabular-nums",
        FINE_PRINT
      )}
      title={window.label}
    >
      {window.label}
    </span>
    <UsageBar
      className="min-w-0 flex-1"
      label={`${provider} ${windowSentence(window)}`}
      window={window}
    />
    <span className={cn("w-7 shrink-0 text-right tabular-nums", FINE_PRINT)}>
      {window.remainingText}
    </span>
    {window.resetsInText === null ? null : (
      <span
        className={cn(
          "w-11 shrink-0 truncate text-right text-muted-foreground",
          FINE_PRINT
        )}
      >
        {window.resetsInText}
      </span>
    )}
  </div>
);

/** One provider in the open sidebar. */
const ProviderRows = ({ view }: { readonly view: ProviderView }) => (
  <div className="flex flex-col gap-1">
    <div className="flex items-baseline gap-1.5">
      <span className="truncate font-medium text-xs">{view.name}</span>
      {view.kind === "readable" && view.statusText !== null ? (
        <span
          className={cn("ml-auto truncate text-muted-foreground", FINE_PRINT)}
        >
          {view.statusText}
        </span>
      ) : null}
    </div>
    {view.kind === "readable" ? (
      view.windows.map((window) => (
        <WindowRow key={window.kind} provider={view.name} window={window} />
      ))
    ) : (
      <p className={cn("text-muted-foreground", FINE_PRINT)}>{view.reason}</p>
    )}
  </div>
);

/**
 * The reading with its bars, which is what the open sidebar and the sheet show.
 *
 * The heading carries the document's own age on the right. A percentage with no
 * age behind it looks live when it is not, and the one time this panel matters
 * most — the loop is down, somebody is looking for why — is exactly the time the
 * figures stop moving while still being figures.
 */
const UsageReading = ({ view }: { readonly view: UsageView }) => (
  <div className="flex flex-col gap-2">
    <div className="flex items-baseline gap-1.5">
      <span
        className={cn(
          "font-medium text-muted-foreground uppercase tracking-wide",
          FINE_PRINT
        )}
      >
        Usage
      </span>
      {view.kind === "published" && view.publishedText !== null ? (
        <span
          className={cn("ml-auto truncate text-muted-foreground", FINE_PRINT)}
        >
          {view.publishedText}
        </span>
      ) : null}
    </div>
    {view.kind === "blank" ? (
      <p className={cn("text-muted-foreground", FINE_PRINT)}>{view.message}</p>
    ) : (
      view.providers.map((provider) => (
        <ProviderRows key={provider.provider} view={provider} />
      ))
    )}
  </div>
);

/**
 * The same reading in words, for the rail's tooltip.
 *
 * Text rather than the bars above it: the tooltip paints itself in the inverted
 * pair, where a bar coloured against the page's tokens would be somewhere
 * between hard to read and invisible. It also has the room the rail does not, so
 * this is where the window spans, the resets and the state get said in full.
 */
const UsageDigest = ({ view }: { readonly view: UsageView }) => {
  if (view.kind === "blank") {
    return <span>{view.message}</span>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {view.providers.map((provider) => (
        <div className="flex flex-col" key={provider.provider}>
          <span className="font-medium">
            {provider.name}
            {provider.kind === "readable" && provider.statusText !== null
              ? ` — ${provider.statusText}`
              : ""}
          </span>
          {provider.kind === "readable" ? (
            provider.windows.map((window) => (
              <span className="opacity-80" key={window.kind}>
                {windowSentence(window)}
              </span>
            ))
          ) : (
            <span className="opacity-80">{provider.reason}</span>
          )}
          {provider.readText === null ? null : (
            <span className="opacity-60">{provider.readText}</span>
          )}
        </div>
      ))}
    </div>
  );
};

/** The rail's whole content: one hairline per provider, worst window first. */
const RailBars = ({ view }: { readonly view: UsageView }) => {
  if (view.kind === "blank") {
    return <NoBar />;
  }
  return (
    <>
      {view.providers.map((provider) =>
        provider.kind === "readable" ? (
          <UsageBar
            key={provider.provider}
            label={null}
            window={provider.worst}
          />
        ) : (
          <NoBar key={provider.provider} />
        )
      )}
    </>
  );
};

/**
 * Remaining allowance on both providers, for the sidebar footer.
 *
 * The reading is polled rather than pushed — see `@/api/usage` for the period —
 * and every figure derived from it is worked out against a clock read here, so
 * "resets in 42m" is 42 minutes from now rather than from whenever the loop last
 * wrote the file.
 */
export const UsageMeters = () => {
  const usage = useQuery(usageQuery());

  if (usage.isPending) {
    return (
      <output
        aria-label="Reading provider usage"
        className="flex flex-col gap-1.5 px-1"
      >
        <Skeleton className="h-1 w-full" />
        <Skeleton className="h-1 w-full" />
      </output>
    );
  }

  // A reading already in hand outlives a poll that failed: the age beside it
  // says how old it is, which is a truer answer than replacing figures the gate
  // is still deciding with because one request did not come back.
  const view =
    usage.data === undefined
      ? blankUsage(
          `${READ_FAILED} ${failureSentence(usage.error) ?? ""}`.trim()
        )
      : usageView(usage.data, DateTime.nowUnsafe());

  return (
    <>
      <div className="flex flex-col gap-2 px-1 group-data-[collapsible=icon]:hidden">
        <UsageReading view={view} />
      </div>

      {/*
        The rail. Two hairlines and no words, so the trigger carries the reading
        as its name and the tooltip carries it as text. A button because a
        tooltip a keyboard cannot reach is a tooltip half the operators never
        see; it does nothing when pressed, which is the honest behaviour for a
        readout.
      */}
      <div className="hidden group-data-[collapsible=icon]:block">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                aria-label={usageSummary(view)}
                className="flex w-full cursor-default flex-col gap-1 rounded-md p-1 hover:bg-sidebar-accent"
                type="button"
              />
            }
          >
            <RailBars view={view} />
          </TooltipTrigger>
          <TooltipContent
            className="w-56 flex-col items-start gap-1 text-left"
            side="right"
          >
            <UsageDigest view={view} />
          </TooltipContent>
        </Tooltip>
      </div>
    </>
  );
};
