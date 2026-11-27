/**
 * What each demo run did, step by step. One script feeds both the run's event
 * timeline and its session transcript, so the two views tell the same story.
 */

import type {
  RunOutcome,
  RunTrigger,
  SessionProvider,
} from "@workspace/domain";

export type Step =
  | { readonly kind: "say"; readonly text: string }
  | { readonly kind: "think"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly ok?: boolean;
      readonly result: string;
      readonly summary: string;
      readonly tool: string;
    }
  | { readonly kind: "log"; readonly text: string };

const say = (text: string): Step => ({ kind: "say", text });
const think = (text: string): Step => ({ kind: "think", text });
const log = (text: string): Step => ({ kind: "log", text });
const tool = (
  name: string,
  summary: string,
  result: string,
  ok = true
): Step => ({ kind: "tool", ok, result, summary, tool: name });

export interface RunScript {
  /** Minutes the run took, or has taken so far when it is live. */
  readonly minutes: number;
  readonly model: string;
  readonly outcome: RunOutcome | null;
  readonly provider: SessionProvider;
  /** Minutes before page load the run started. */
  readonly started: number;
  readonly steps: readonly Step[];
  readonly taskKey: string;
  readonly trigger: RunTrigger;
}

const CLAUDE = "claude-opus-5-5";
const CODEX = "gpt-5.5-codex";
const PI = "deepseek-v4";

export const SCRIPTS: Record<string, RunScript> = {
  areas: {
    minutes: 11,
    model: PI,
    outcome: "done",
    provider: "pi",
    started: 2 * 24 * 60 + 30,
    steps: [
      say("Reading the brief and the trip notes first."),
      tool("read", "read notes/trip.md", "42 lines"),
      tool("web_search", "search: Alfama noise at night tram 28", "8 results"),
      tool(
        "web_search",
        "search: Campo de Ourique for a week stay",
        "6 results"
      ),
      tool("write", "write lisbon-areas.md", "3.1 KB written"),
      say(
        "Shortlist is in lisbon-areas.md: Príncipe Real first, Campo de Ourique second, Alfama only with a room off the tram line."
      ),
    ],
    taskKey: "lisbon-areas",
    trigger: "research",
  },
  covers: {
    minutes: 14,
    model: CLAUDE,
    outcome: null,
    provider: "claude",
    started: 14,
    steps: [
      say(
        "Starting with how the site draws its OG cards, so the covers match."
      ),
      tool("Read", "src/lib/og/template.tsx", "118 lines"),
      tool("Read", "scripts/poster.ts", "64 lines"),
      think(
        "The poster script already renders with satori. I can reuse the OG template and pass the post title and date."
      ),
      tool("Grep", "grep 'cover' content/blog", "0 matches"),
      tool("Edit", "scripts/poster.ts: one PNG per post", "+38 −6"),
      tool("Bash", "bun run poster", "wrote 9 covers to public/blog"),
      tool(
        "Bash",
        "bun run check",
        "1 error: unused import in scripts/poster.ts",
        false
      ),
      tool("Edit", "scripts/poster.ts: drop unused import", "+0 −1"),
      tool("Bash", "bun run check", "no errors"),
      say(
        "Covers render for all 9 posts. Wiring them into the blog index next, with width and height set so nothing shifts."
      ),
      tool("Edit", "src/app/blog/page.tsx: use cover per post", "+12 −3"),
    ],
    taskKey: "covers",
    trigger: "status_change",
  },
  doubleBooking: {
    minutes: 22,
    model: CLAUDE,
    outcome: null,
    provider: "claude",
    started: 22,
    steps: [
      say("Reproducing it first, with two saves on one slot in a test."),
      tool("Read", "src/db/schema/bookings.ts", "71 lines"),
      tool("Read", "src/app/api/bookings/route.ts", "96 lines"),
      think(
        "The insert checks for a free slot with a SELECT, then INSERTs. Two requests can both pass the SELECT."
      ),
      tool("Edit", "test/bookings.test.ts: two saves at once", "+41 −0"),
      tool(
        "Bash",
        "bun test test/bookings.test.ts",
        "1 fail: expected 1 booking, got 2",
        false
      ),
      say(
        "Reproduced. Fixing it with an exclusion constraint on therapist and time range, so Postgres refuses the second row."
      ),
      tool("Edit", "drizzle/0019_booking_no_overlap.sql", "+9 −0"),
      tool("Bash", "bun run db:migrate", "applied 0019_booking_no_overlap"),
      tool("Edit", "src/app/api/bookings/route.ts: map 23P01 to 409", "+14 −8"),
      tool("Bash", "bun test", "48 pass, 0 fail"),
    ],
    taskKey: "double-booking",
    trigger: "status_change",
  },
  effectTimeout: {
    minutes: 60,
    model: CODEX,
    outcome: "timeout",
    provider: "codex",
    started: 5 * 60,
    steps: [
      tool("shell", "bun update effect @effect/*", "updated 6 packages"),
      tool("shell", "bun run typecheck", "212 errors in 31 files", false),
      say("Working through the type errors package by package."),
      log("run hit its 60 minute limit"),
    ],
    taskKey: "effect-bump",
    trigger: "status_change",
  },
  egress: {
    minutes: 31,
    model: CODEX,
    outcome: "done",
    provider: "codex",
    started: 3 * 60 + 40,
    steps: [
      say("Looking at how the sandbox container is started."),
      tool("shell", "rg -n 'network' packages/sandbox/src", "14 matches"),
      tool("read_file", "packages/sandbox/src/container.ts", "212 lines"),
      tool("apply_patch", "packages/sandbox/src/egress.ts", "+88 −0"),
      tool("shell", "bun run sandbox:check --agent", "9 claims hold"),
      tool("shell", "gh pr create", "opened #83"),
      say(
        "Opened #83. Only the registry cache and api.github.com are reachable."
      ),
    ],
    taskKey: "egress",
    trigger: "status_change",
  },
  hotel: {
    minutes: 9,
    model: PI,
    outcome: "done",
    provider: "pi",
    started: 26 * 60,
    steps: [
      tool("web_search", "search: Alfama hotel view under 180", "10 results"),
      tool("write", "alfama-hotels.md", "2.4 KB written"),
      say(
        "Three picks in alfama-hotels.md. The second one has the quietest reviews."
      ),
    ],
    taskKey: "hotel",
    trigger: "status_change",
  },
  keepDate: {
    minutes: 12,
    model: CLAUDE,
    outcome: "done",
    provider: "claude",
    started: 5 * 60 + 20,
    steps: [
      tool("Read", "src/components/booking-form.tsx", "140 lines"),
      tool(
        "Edit",
        "src/components/booking-form.tsx: keep date in state",
        "+6 −2"
      ),
      tool("Bash", "bun test", "47 pass"),
      tool("Bash", "gh pr create", "opened #41"),
      say("Opened #41."),
    ],
    taskKey: "keep-date",
    trigger: "status_change",
  },
  lazyEmbed: {
    minutes: 8,
    model: CODEX,
    outcome: "done",
    provider: "codex",
    started: 7 * 60 + 15,
    steps: [
      tool("read_file", "src/app/contact/page.tsx", "88 lines"),
      tool("apply_patch", "src/components/contact/cal-embed.tsx", "+29 −4"),
      tool("shell", "gh pr create --draft", "opened #279"),
      say("Draft #279. It needs a screenshot before review."),
    ],
    taskKey: "lazy-embed",
    trigger: "status_change",
  },
  prIcon: {
    minutes: 4,
    model: CLAUDE,
    outcome: "done",
    provider: "claude",
    started: 3 * 24 * 60,
    steps: [say("Done.")],
    taskKey: "pr-icon",
    trigger: "status_change",
  },
  quota: {
    minutes: 17,
    model: CODEX,
    outcome: "done",
    provider: "codex",
    started: 3 * 24 * 60 + 60,
    steps: [say("Merged as #78.")],
    taskKey: "quota",
    trigger: "status_change",
  },
  sintra: {
    minutes: 9,
    model: PI,
    outcome: null,
    provider: "pi",
    started: 9,
    steps: [
      say("Checking trains from Rossio and the palace opening hours."),
      tool(
        "web_search",
        "search: Rossio to Sintra train timetable March",
        "7 results"
      ),
      tool(
        "web_search",
        "search: Pena Palace tickets timed entry",
        "5 results"
      ),
      think(
        "Pena first at opening, then Quinta da Regaleira before the groups arrive."
      ),
      tool("read", "lisbon-areas.md", "61 lines"),
      tool("write", "day-3-sintra.md", "1.8 KB written"),
    ],
    taskKey: "sintra",
    trigger: "status_change",
  },
  sse: {
    minutes: 38,
    model: CODEX,
    outcome: null,
    provider: "codex",
    started: 38,
    steps: [
      say("Reading how the board is served today."),
      tool("shell", "rg -n 'refetchInterval' apps/dashboard/src", "6 matches"),
      tool("read_file", "apps/gateway/src/handlers/tasks.ts", "290 lines"),
      tool(
        "read_file",
        "packages/db/src/repositories/task-board.ts",
        "175 lines"
      ),
      think(
        "One LISTEN per gateway process, fanned out to every open board. The client keeps its cache and replaces columns on each push."
      ),
      tool(
        "apply_patch",
        "packages/db/drizzle/0031_board_notify.sql",
        "+22 −0"
      ),
      tool("apply_patch", "apps/gateway/src/board-sse.ts", "+140 −0"),
      tool("shell", "bun run typecheck", "no errors"),
      tool("apply_patch", "apps/dashboard/src/api/stream.ts", "+96 −0"),
      tool(
        "shell",
        "bun test apps/gateway",
        "1 fail: board-stream reopens after idle timeout",
        false
      ),
      say(
        "The stream closes after 5 minutes of no writes. Reopening it on a clean end, not only on failure."
      ),
      tool(
        "apply_patch",
        "apps/dashboard/src/api/stream.ts: reopen on end",
        "+11 −2"
      ),
      tool("shell", "bun test apps/gateway", "184 pass, 0 fail"),
      tool("shell", "bun run check", "no errors"),
    ],
    taskKey: "sse",
    trigger: "status_change",
  },
  weekView: {
    minutes: 26,
    model: CLAUDE,
    outcome: "done",
    provider: "claude",
    started: 4 * 24 * 60 + 90,
    steps: [say("Merged as #37.")],
    taskKey: "week-view",
    trigger: "status_change",
  },
};
