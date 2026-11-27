import type { Project } from "@workspace/api";
import { ProjectId } from "@workspace/domain";
import { ago, DAY, DEMO_WORKSPACE, demoUuid } from "@/demo/ids";

export const PROJECT = {
  atm: ProjectId.make(demoUuid("project", 1)),
  clinic: ProjectId.make(demoUuid("project", 2)),
  site: ProjectId.make(demoUuid("project", 3)),
  trip: ProjectId.make(demoUuid("project", 4)),
} as const;

interface ProjectSpec {
  readonly age: number;
  readonly description: string;
  readonly id: ProjectId;
  readonly name: string;
  readonly repoUrl: string | null;
}

const project = (spec: ProjectSpec): Project => ({
  createdAt: ago(spec.age),
  description: spec.description,
  id: spec.id,
  name: spec.name,
  repoDefaultBranch: spec.repoUrl === null ? null : "main",
  repoUrl: spec.repoUrl,
  updatedAt: ago(spec.age / 2),
  workspaceId: DEMO_WORKSPACE,
});

export const PROJECTS: readonly Project[] = [
  project({
    age: 110 * DAY,
    description: "This board, the sandboxed agents and the manager.",
    id: PROJECT.atm,
    name: "agent-task-manager",
    repoUrl: "https://github.com/Mark-Life/agent-task-manager",
  }),
  project({
    age: 200 * DAY,
    description: "Personal site: photos first, short text.",
    id: PROJECT.site,
    name: "andrey-markin-website",
    repoUrl: "https://github.com/Mark-Life/andrey-markin-website",
  }),
  project({
    age: 40 * DAY,
    description: "Booking app for a small physio clinic. Next.js and Postgres.",
    id: PROJECT.clinic,
    name: "clinic-booking",
    repoUrl: "https://github.com/example-studio/clinic-booking",
  }),
  project({
    age: 9 * DAY,
    description: "A week in Lisbon in March: flights, a place to stay, days.",
    id: PROJECT.trip,
    name: "lisbon-trip",
    repoUrl: null,
  }),
];
