/**
 * What a session spent, on the session.
 *
 * The number this exists for is the first one: how much of the model's context
 * window this conversation is occupying. A session near the end of its window
 * should be stopped and continued in a fresh one — the board already supports
 * that — and until now nobody could tell a session at a tenth of its window
 * from one at nine tenths without opening the transcript by hand.
 *
 * **Nothing is drawn as a guess.** Three separate things could be unknown here
 * and each says so in words rather than as a shape: a window the provider never
 * reported is marked inferred beside the percentage, a window nothing can
 * supply leaves no bar at all, and a cost is always labelled an estimate with
 * the dated table that produced it. A bar at zero and a bar nobody could fill
 * look identical and mean the opposite things, so the second one is never
 * drawn.
 *
 * **The figures are as old as the last finished run.** They are derived from
 * the transcript when a run ends, so a session with a run in flight is showing
 * what its previous run left. That is stated on the row rather than implied,
 * because a percentage with no age behind it looks live when it is not.
 *
 * The curve is hand-drawn SVG rather than the chart library the UI package
 * carries. It is one polyline against one threshold, the dashboard pulls in no
 * charting today, and a hundred kilobytes of recharts to draw four hundred
 * points is a trade nobody would make twice.
 */

import type { AgentSessionUsage } from "@workspace/api";
import {
  type CostUsd,
  contextFractionOf,
  type SessionUsage,
} from "@workspace/domain";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible";
import { Progress } from "@workspace/ui/components/progress";
import { cn } from "@workspace/ui/lib/utils";
import { formatCost, formatRelative, formatTokens } from "@/lib/format";

/** Everything in this panel is secondary to the board; nothing here shouts. */
const FINE_PRINT = "text-[0.625rem] leading-tight";

/** A percentage is a percentage, not a fraction. */
const PERCENT = 100;

/** Past this much of the window, a fresh session is usually the better move. */
const CROWDED = 0.6;

/** Past this, the conversation is close enough to the wall to say so in red. */
const FULL = 0.85;

/** How many of the biggest items are listed. The tail is a long flat one. */
const SHOWN_ENTRIES = 8;

/** The drawing surface the curve is normalized into. Unitless; the SVG scales. */
const CHART = { height: 100, width: 300 } as const;

/** How the bar is painted at each band. Written out because Tailwind reads these classes out of the source. */
const toneBar = (fraction: number) => {
  if (fraction >= FULL) {
    return "[&_[data-slot=progress-indicator]]:bg-destructive";
  }
  if (fraction >= CROWDED) {
    return "[&_[data-slot=progress-indicator]]:bg-amber-500";
  }
  return "[&_[data-slot=progress-indicator]]:bg-primary";
};

/** A window figure as words: `44% of 1M`, or nothing when there is no window. */
const windowSentence = (usage: SessionUsage) => {
  const fraction = contextFractionOf(usage);
  if (fraction === null) {
    return null;
  }
  return `${Math.round(fraction * PERCENT)}% of ${formatTokens(usage.contextWindow)}`;
};

/** The cost, always with the word that makes it readable. */
const costSentence = (usage: SessionUsage) => {
  if (usage.cost === null) {
    return null;
  }
  const money = formatCost(usage.cost.totalUsd as CostUsd);
  return usage.cost.unpricedRequests > 0
    ? `≥ ${money} est.`
    : `≈ ${money} est.`;
};

/** The whole provenance of a cost, for the title attribute and the panel. */
const costProvenance = (usage: SessionUsage) => {
  if (usage.cost === null) {
    return "No model in this session has a price in the table, so there is no cost to estimate.";
  }
  const table = `priced from table v${usage.cost.priceTableVersion}, rates read ${usage.cost.priceTableEffective}`;
  const missing =
    usage.cost.unpricedRequests > 0
      ? ` ${usage.cost.unpricedRequests} request(s) on ${usage.cost.unpricedModels.join(", ")} could not be priced, so this is a floor.`
      : "";
  return `An estimate of what this session would have cost on the API: ${table}.${missing} A subscription run is not billed per token.`;
};

interface MeterProps {
  /** True while a run is in flight, which is when the figures are a run old. */
  readonly running: boolean;
  readonly usage: SessionUsage;
}

/**
 * The always-on line: how full the window is, what the session spent, and what
 * that would have cost.
 */
export const SessionUsageMeter = ({ running, usage }: MeterProps) => {
  const fraction = contextFractionOf(usage);
  const window = windowSentence(usage);
  const cost = costSentence(usage);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {fraction === null ? (
          // No denominator, so no bar. An empty track says "nothing to
          // measure against" where a bar at zero would say "nothing used".
          <span
            aria-hidden="true"
            className="block h-1 min-w-0 flex-1 rounded-md bg-muted"
          />
        ) : (
          <Progress
            aria-label={`Context window ${window}`}
            className={cn("min-w-0 flex-1 gap-0", toneBar(fraction))}
            value={fraction * PERCENT}
          />
        )}
        <span className={cn("shrink-0 tabular-nums", FINE_PRINT)}>
          {window ?? "context window unknown"}
        </span>
      </div>
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground",
          FINE_PRINT
        )}
      >
        {usage.contextWindowSource === null ? null : (
          <span
            title={
              usage.contextWindowSource === "reported"
                ? "The provider wrote this window into its own transcript."
                : "The provider records no context window, so this one is looked up from the model id and can be wrong."
            }
          >
            window {usage.contextWindowSource}
          </span>
        )}
        <span className="tabular-nums">
          peak {formatTokens(usage.peakContextTokens)}
        </span>
        <span className="tabular-nums">
          out {formatTokens(usage.totals.outputTokens) ?? "—"}
        </span>
        <span className="tabular-nums">{usage.requests} requests</span>
        {cost === null ? (
          <span title={costProvenance(usage)}>cost unavailable</span>
        ) : (
          <span className="tabular-nums" title={costProvenance(usage)}>
            {cost}
          </span>
        )}
        <span className="ml-auto">
          {running ? "as of last finished run, " : ""}
          computed {formatRelative(usage.computedAt)}
        </span>
      </div>
    </div>
  );
};

/**
 * The context curve, one point per model request.
 *
 * Drawn against the window rather than against its own maximum, which is the
 * whole point: a curve autoscaled to its own peak looks alarming at 4% and calm
 * at 95%. Where there is no window, it falls back to its own peak and the
 * caption says so.
 */
const GrowthChart = ({ usage }: { readonly usage: SessionUsage }) => {
  const points = usage.growth;
  const ceiling =
    usage.contextWindow ??
    Math.max(1, ...points.map((point) => point.contextTokens));
  const step = points.length > 1 ? CHART.width / (points.length - 1) : 0;
  const path = points
    .map((point, index) => {
      const x = index * step;
      const y =
        CHART.height -
        (Math.min(point.contextTokens, ceiling) / ceiling) * CHART.height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <figure className="flex flex-col gap-1">
      <svg
        aria-label={`Context growth over ${points.length} requests, peaking at ${formatTokens(usage.peakContextTokens)}`}
        className="h-24 w-full"
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
      >
        {/* The band past which a fresh session is usually the better move. */}
        <rect
          className="fill-amber-500/10"
          height={CHART.height * (1 - CROWDED)}
          width={CHART.width}
          x={0}
          y={0}
        />
        <path
          className="fill-none stroke-primary"
          d={path}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className={cn("text-muted-foreground", FINE_PRINT)}>
        {points.length} of {usage.requests} requests
        {usage.growthSampled
          ? " (thinned to fit; the ends and the peak are kept)"
          : ""}
        {usage.contextWindow === null
          ? " · drawn against this session's own peak, since no window is known"
          : " · drawn against the context window"}
      </figcaption>
    </figure>
  );
};

/** One labelled figure, with an em dash where the provider reported none. */
const Figure = ({
  label,
  title,
  value,
}: {
  readonly label: string;
  readonly title?: string;
  readonly value: string | null;
}) => (
  <div className="flex flex-col" title={title}>
    <span className={cn("text-muted-foreground", FINE_PRINT)}>{label}</span>
    <span className="text-xs tabular-nums">{value ?? "—"}</span>
  </div>
);

/** The detail behind the meter: the curve, the totals, the tools, the biggest items. */
const SessionUsageDetail = ({ usage }: { readonly usage: SessionUsage }) => (
  <div className="flex flex-col gap-3 pt-2">
    <GrowthChart usage={usage} />

    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
      <Figure
        label="input"
        title="Fresh prompt tokens — what neither cache covered."
        value={formatTokens(usage.totals.inputTokens)}
      />
      <Figure
        label="cache read"
        value={formatTokens(usage.totals.cacheReadTokens)}
      />
      <Figure
        label="cache write"
        title="Tokens written into the prompt cache. A dash means the provider does not report it."
        value={formatTokens(usage.totals.cacheWriteTokens)}
      />
      <Figure label="output" value={formatTokens(usage.totals.outputTokens)} />
      <Figure
        label="thinking"
        title="The thinking half of output, where the provider separates it. Claude folds it into output."
        value={formatTokens(usage.totals.reasoningOutputTokens)}
      />
    </div>

    <div className="flex flex-wrap gap-1">
      {usage.models.map((model) => (
        <Badge key={model} variant="outline">
          {model}
        </Badge>
      ))}
    </div>

    {usage.toolCalls.length === 0 ? null : (
      <div className="flex flex-col gap-0.5">
        <span className={cn("text-muted-foreground", FINE_PRINT)}>
          tool calls
        </span>
        <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
          {usage.toolCalls.map((tool) => (
            <li className="tabular-nums" key={tool.name}>
              <span className="text-muted-foreground">{tool.name}</span>{" "}
              {tool.calls}
              {tool.errors > 0 ? (
                <span className="text-destructive">
                  {" "}
                  ({tool.errors} failed)
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    )}

    {usage.largestEntries.length === 0 ? null : (
      <div className="flex flex-col gap-0.5">
        <span className={cn("text-muted-foreground", FINE_PRINT)}>
          biggest things in the conversation, in characters
        </span>
        <ul className="flex flex-col text-xs">
          {usage.largestEntries.slice(0, SHOWN_ENTRIES).map((entry) => (
            <li
              className="flex gap-2"
              key={`${entry.line}-${entry.role}-${entry.chars}`}
            >
              <span className="w-24 shrink-0 text-muted-foreground">
                {entry.toolName ?? entry.role}
              </span>
              <span className="tabular-nums">
                {entry.chars.toLocaleString()}
              </span>
              <span className="text-muted-foreground">line {entry.line}</span>
            </li>
          ))}
        </ul>
      </div>
    )}

    <p className={cn("text-muted-foreground", FINE_PRINT)}>
      {costProvenance(usage)}
    </p>
  </div>
);

interface PanelProps {
  readonly running: boolean;
  /** Nothing recorded for this session yet, which is not the same as nothing spent. */
  readonly usage: AgentSessionUsage | undefined;
}

/** The meter, with the detail behind a disclosure. */
export const SessionUsagePanel = ({ running, usage }: PanelProps) => {
  if (usage === undefined) {
    return (
      <p className={cn("text-muted-foreground", FINE_PRINT)}>
        Nothing recorded yet. A session's figures are worked out when a run on
        it finishes.
      </p>
    );
  }

  return (
    <Collapsible className="flex flex-col gap-1">
      <SessionUsageMeter running={running} usage={usage.usage} />
      <CollapsibleTrigger
        render={
          <Button
            className="h-6 self-start px-1 text-[0.625rem] text-muted-foreground"
            size="xs"
            variant="ghost"
          />
        }
      >
        Growth and breakdown
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SessionUsageDetail usage={usage.usage} />
      </CollapsibleContent>
    </Collapsible>
  );
};
