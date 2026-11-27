import type { Task } from "@workspace/api";
import {
  type ProjectId,
  type PrState,
  RANK_STEP,
  TaskId,
  type TaskStatus,
} from "@workspace/domain";
import { ago, DAY, DEMO_WORKSPACE, demoUuid, HOUR } from "@/demo/ids";
import { PROJECT, PROJECTS } from "./projects";

interface TaskSpec {
  readonly acceptance?: string;
  readonly brief: string;
  /** Minutes since the card was filed. */
  readonly filed: number;
  readonly key: string;
  /** Minutes since the card last changed column. */
  readonly moved: number;
  readonly pr?: { readonly number: number; readonly state: PrState };
  readonly projectId: ProjectId;
  readonly status: TaskStatus;
  readonly title: string;
}

const SPECS: readonly TaskSpec[] = [
  {
    brief:
      "Forward a voice note to the bot and it lands in ideas, transcribed, with the project guessed from what I said.",
    filed: 2 * HOUR,
    key: "voice-ideas",
    moved: 2 * HOUR,
    projectId: PROJECT.atm,
    status: "ideas",
    title: "Voice notes from Telegram straight into ideas",
  },
  {
    brief:
      "Every Sunday the manager writes one message: what merged, what is stuck in review, what cost the most.",
    filed: 3 * DAY,
    key: "digest",
    moved: 3 * DAY,
    projectId: PROJECT.atm,
    status: "ideas",
    title: "Weekly digest of what the agents shipped",
  },
  {
    brief:
      "Click a film photo on the about page and it opens full screen, with the camera and the roll in a caption.",
    filed: 5 * DAY,
    key: "lightbox",
    moved: 5 * DAY,
    projectId: PROJECT.site,
    status: "ideas",
    title: "Film photo lightbox on the about page",
  },
  {
    brief:
      "Research runs mostly read and summarise. See if Pi on a cheaper model does them as well as Claude.",
    filed: 6 * DAY,
    key: "pi-research",
    moved: 6 * DAY,
    projectId: PROJECT.atm,
    status: "ideas",
    title: "Try Pi on a cheaper model for research runs",
  },
  {
    acceptance: "A shortlist of 3 areas with a reason each, and what to avoid.",
    brief:
      "Where to stay for a week: walkable, near trams, quiet at night. Compare Alfama, Príncipe Real and Campo de Ourique.",
    filed: 4 * DAY,
    key: "lisbon-areas",
    moved: 2 * DAY,
    projectId: PROJECT.trip,
    status: "backlog",
    title: "Research: where to stay in Lisbon for a week",
  },
  {
    brief:
      "A case study page for this project on my site. Board, runs, the manager chat. Screenshots from the demo build.",
    filed: 1 * DAY,
    key: "atm-page",
    moved: 1 * DAY,
    projectId: PROJECT.site,
    status: "backlog",
    title: "Add the Agent Task Manager project page",
  },
  {
    brief:
      "The manager reads the board through the API. Give it one call that returns the board as Markdown, so it spends fewer tokens.",
    filed: 2 * DAY,
    key: "board-md",
    moved: 2 * DAY,
    projectId: PROJECT.atm,
    status: "backlog",
    title: "Board as Markdown for the manager",
  },
  {
    acceptance:
      "Reminder 24 h before, a link to cancel, no reminder for a booking made less than 24 h ahead.",
    brief:
      "Patients forget. Send an SMS the day before each appointment, through the provider the clinic already pays for.",
    filed: 3 * DAY,
    key: "sms",
    moved: 3 * DAY,
    projectId: PROJECT.clinic,
    status: "backlog",
    title: "Appointment reminders by SMS",
  },
  {
    brief:
      "Direct flights Zurich to Lisbon, 12 to 19 March. Track prices for a week and say when to book.",
    filed: 4 * DAY,
    key: "flights",
    moved: 4 * DAY,
    projectId: PROJECT.trip,
    status: "backlog",
    title: "Watch flight prices Zurich → Lisbon",
  },
  {
    acceptance:
      "`bun run poster` writes a PNG per post, the blog index uses them, no layout shift.",
    brief:
      "Blog posts have no covers yet. Generate one per post from the title, in the site's paper and ink colours.",
    filed: 1 * DAY,
    key: "covers",
    moved: 14,
    projectId: PROJECT.site,
    status: "in_progress",
    title: "Blog: cover images from the poster script",
  },
  {
    acceptance:
      "The board and the run timeline update without polling. A dropped connection reconnects.",
    brief:
      "The dashboard polls every few seconds. Push the board and the run timeline over SSE from Postgres LISTEN/NOTIFY.",
    filed: 2 * DAY,
    key: "sse",
    moved: 38,
    projectId: PROJECT.atm,
    status: "in_progress",
    title: "Stream the board and run timelines instead of polling",
  },
  {
    acceptance:
      "Two staff saving the same slot: one wins, the other sees the slot is taken. Test that proves it.",
    brief:
      "Two people at the desk can book the same 10:00 slot if they save within a second. Fix it in the database, not in the UI.",
    filed: 6 * HOUR,
    key: "double-booking",
    moved: 22,
    projectId: PROJECT.clinic,
    status: "in_progress",
    title: "Fix double booking when two staff save one slot",
  },
  {
    brief:
      "Day 3: Sintra in the morning, the coast after lunch. Trains, tickets to buy ahead, where to eat.",
    filed: 1 * DAY,
    key: "sintra",
    moved: 9,
    projectId: PROJECT.trip,
    status: "in_progress",
    title: "Plan day 3: Sintra and the coast",
  },
  {
    brief:
      "Bump effect and @effect/* to the same beta in every package and fix what the type checker finds.",
    filed: 2 * DAY,
    key: "effect-bump",
    moved: 3,
    projectId: PROJECT.atm,
    status: "in_progress",
    title: "Upgrade Effect across all packages",
  },
  {
    brief:
      "Agents only need the package registry and GitHub. Block everything else from inside the sandbox.",
    filed: 3 * DAY,
    key: "egress",
    moved: 3 * HOUR,
    pr: { number: 83, state: "open" },
    projectId: PROJECT.atm,
    status: "review",
    title: "Sandbox: block outbound network except the package cache",
  },
  {
    brief:
      "When the form fails validation it clears the date. Keep what the patient picked.",
    filed: 2 * DAY,
    key: "keep-date",
    moved: 5 * HOUR,
    pr: { number: 41, state: "open" },
    projectId: PROJECT.clinic,
    status: "review",
    title: "Booking form: keep the date when validation fails",
  },
  {
    brief:
      "The contact page loads the booking widget on first paint. Load it when it scrolls into view.",
    filed: 2 * DAY,
    key: "lazy-embed",
    moved: 7 * HOUR,
    pr: { number: 279, state: "draft" },
    projectId: PROJECT.site,
    status: "review",
    title: "Contact page: load the booking embed lazily",
  },
  {
    brief:
      "Three hotels in Alfama under 180 a night with a view. Check reviews for noise.",
    filed: 3 * DAY,
    key: "hotel",
    moved: 1 * DAY,
    projectId: PROJECT.trip,
    status: "review",
    title: "Shortlist hotels in Alfama",
  },
  {
    brief: "Show the pull request's state on the card's own icon.",
    filed: 6 * DAY,
    key: "pr-icon",
    moved: 2 * DAY,
    pr: { number: 79, state: "merged" },
    projectId: PROJECT.atm,
    status: "done",
    title: "Dashboard: PR state on the card icon",
  },
  {
    brief:
      "When the quota read fails, keep the last good reading and mark it stale.",
    filed: 6 * DAY,
    key: "quota",
    moved: 3 * DAY,
    pr: { number: 78, state: "merged" },
    projectId: PROJECT.atm,
    status: "done",
    title: "Quota: keep the last good reading",
  },
  {
    brief: "Add Kache to the directory page, with its screenshot.",
    filed: 4 * DAY,
    key: "kache",
    moved: 2 * DAY,
    pr: { number: 268, state: "merged" },
    projectId: PROJECT.site,
    status: "done",
    title: "Directory: add Kache",
  },
  {
    brief: "Staff see the week at a glance, one column per therapist.",
    filed: 8 * DAY,
    key: "week-view",
    moved: 4 * DAY,
    pr: { number: 37, state: "merged" },
    projectId: PROJECT.clinic,
    status: "done",
    title: "Staff calendar: week view",
  },
  {
    brief: "Book the flights the price watch picked.",
    filed: 7 * DAY,
    key: "book-flights",
    moved: 5 * DAY,
    projectId: PROJECT.trip,
    status: "done",
    title: "Book flights for 12–19 March",
  },
];

const repoOf = (projectId: ProjectId) =>
  PROJECTS.find((project) => project.id === projectId)?.repoUrl ?? null;

const prUrlOf = (spec: TaskSpec) =>
  spec.pr === undefined
    ? null
    : `${repoOf(spec.projectId)}/pull/${spec.pr.number}`;

/** Task ids by fixture key, so other fixtures can point at a card by name. */
export const TASK: Record<string, TaskId> = Object.fromEntries(
  SPECS.map((spec, index) => [
    spec.key,
    TaskId.make(demoUuid("task", index + 1)),
  ])
);

export const taskIdOf = (key: string) => {
  const id = TASK[key];
  if (id === undefined) {
    throw new Error(`no demo task ${key}`);
  }
  return id;
};

const rankInColumn = (spec: TaskSpec) =>
  SPECS.filter((other) => other.status === spec.status).indexOf(spec) *
  RANK_STEP;

export const TASKS: readonly Task[] = SPECS.map((spec) => ({
  acceptance: spec.acceptance ?? null,
  brief: spec.brief,
  createdAt: ago(spec.filed),
  dispatchTraceparent: null,
  id: taskIdOf(spec.key),
  metadata: {},
  nextSessionId: null,
  nextSessionNew: false,
  parentTaskId: null,
  parkedUntil: null,
  projectId: spec.projectId,
  prState: spec.pr?.state ?? null,
  prStateAt: spec.pr === undefined ? null : ago(spec.moved),
  prUrl: prUrlOf(spec),
  rank: rankInColumn(spec),
  repoUrl: repoOf(spec.projectId),
  sandboxImage: null,
  status: spec.status,
  statusChangedAt: ago(spec.moved),
  title: spec.title,
  updatedAt: ago(spec.moved),
  workspaceId: DEMO_WORKSPACE,
}));
