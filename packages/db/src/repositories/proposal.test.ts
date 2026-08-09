/**
 * The store's half of a proposal, against a real database, because every claim
 * here is a claim about a constraint or a lock rather than about a value.
 *
 * Three of them matter. A collected proposal lands `pending` and there is no
 * argument that would make it land otherwise — that is what the read-only mount
 * buys, expressed in the one place a row can be written. Collecting the same
 * file twice records one request, because the file is not deleted after it is
 * read and a rerun meets it again. And a decision happens once: the second
 * answer is refused under the row lock rather than overwriting the first
 * person's.
 *
 * The audit rows are asserted too. A rule change accepted with nobody's name on
 * it is the failure the whole proposal path exists to prevent.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import type {
  Project,
  ProposalPath,
  Run,
  Task,
  WorkspaceId,
} from "@workspace/domain";
import { Actor, UserId } from "@workspace/domain";
import { Cause, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { CurrentActor, withActor } from "../actor";
import { storeLayer } from "../store";
import { ProjectRepo } from "./project";
import { ProposalRepo } from "./proposal";
import { RunRepo } from "./run";
import { AgentSessionRepo } from "./session";
import { TaskRepo } from "./task";
import { WorkspaceRepo } from "./workspace";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "db-proposal-test";

/** The database has never been seeded, so there is no workspace to hang a task on. */
class NoWorkspace extends Schema.TaggedErrorClass<NoWorkspace>()(
  "ProposalRepoTest.NoWorkspace",
  { detail: Schema.String }
) {}

const caller = Actor.cases.system.make({ reason: APPLICATION_NAME });

/** The person who answers. Deciding is a person's act, and the column says so. */
const decider = UserId.make(APPLICATION_NAME);

/**
 * Who tears the fixtures down. Erasing a task is owner-only, so the cleanup
 * asks as a person even though everything else here writes as the system.
 */
const remover = { kind: "human", userId: decider } as const;

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    storeLayer({ applicationName: APPLICATION_NAME }),
    CurrentActor.layer(caller)
  )
);

let workspaceId: WorkspaceId;
let project: Project;
let run: Run;
let task: Task;

/** The digest the collector records, which is what a second pass recognises. */
const digestOf = (body: string) =>
  `sha256:${createHash("sha256").update(body).digest("hex")}`;

/** What a run asked for, as the collector hands it to the store. */
const proposalOf = (input: {
  readonly body: string;
  readonly sourcePath: string;
}) => ({
  body: input.body,
  contentHash: digestOf(input.body),
  path: "CLAUDE.md" as ProposalPath,
  projectId: null,
  runId: run.id,
  scope: "workspace" as const,
  sourcePath: input.sourcePath,
  taskId: task.id,
  workspaceId,
});

/** Every audit row about one proposal, oldest first. */
const auditFor = Effect.fnUntraced(function* (id: string) {
  const sql = yield* PgClient.PgClient;
  return yield* sql`
    select action, actor_kind, actor_user_id from audit_entry
    where entity_id = ${id} and entity_type = 'proposal'
    order by created_at
  `;
});

beforeAll(async () => {
  const built = await runtime.runPromise(
    Effect.gen(function* () {
      const workspaces = yield* WorkspaceRepo;
      const [first] = yield* workspaces.list();
      if (first === undefined) {
        return yield* Effect.fail(
          new NoWorkspace({ detail: "run `bun run db:seed` first" })
        );
      }
      const projects = yield* ProjectRepo;
      const tasks = yield* TaskRepo;
      const made = yield* projects.create({
        name: "proposals: the rules a run wanted changed",
        workspaceId: first.id,
      });
      const raised = yield* tasks.create({
        projectId: made.id,
        title: "proposals: the run that asked",
        workspaceId: first.id,
      });
      // A real run, because the row names the attempt that asked: a person
      // deciding a rule change wants the thread back to the work behind it.
      const sessions = yield* AgentSessionRepo;
      const runs = yield* RunRepo;
      const subject = { id: raised.id, kind: "task" } as const;
      const session = yield* sessions.open({
        provider: "claude",
        subject,
        workspaceId: first.id,
      });
      const attempt = yield* runs.create({
        agentSessionId: session.id,
        provider: "claude",
        subject,
        trigger: "status_change",
        workspaceId: first.id,
      });
      return {
        project: made,
        run: attempt,
        task: raised,
        workspaceId: first.id,
      };
    }).pipe(withActor(caller))
  );

  ({ project, run, task, workspaceId } = built);
});

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      const projects = yield* ProjectRepo;
      yield* tasks.delete({ id: task.id, workspaceId });
      yield* projects.delete({ id: project.id, workspaceId });
    }).pipe(withActor(remover))
  );
  await runtime.dispose();
});

test("a collected proposal lands pending, undecided and attributed to nobody", async () => {
  const { proposal, recorded, entries } = await runtime.runPromise(
    Effect.gen(function* () {
      const proposals = yield* ProposalRepo;
      const written = yield* proposals.record(
        proposalOf({
          body: "# House style\n\nShort words.",
          sourcePath: "a.md",
        })
      );
      return {
        entries: yield* auditFor(written.proposal.id),
        proposal: written.proposal,
        recorded: written.recorded,
      };
    }).pipe(withActor(caller))
  );

  expect(recorded).toBe(true);
  expect(proposal.state).toBe("pending");
  expect(proposal.decidedAt).toBeNull();
  expect(proposal.decidedBy).toBeNull();
  // The run asked; the row records that it did, and nothing more.
  expect(entries).toHaveLength(1);
  expect(entries[0]?.action).toBe("create");
});

test("the same file with the same bytes is one request, not a second", async () => {
  const source = proposalOf({ body: "Prefer a link.", sourcePath: "again.md" });
  const { first, second } = await runtime.runPromise(
    Effect.gen(function* () {
      const proposals = yield* ProposalRepo;
      return {
        first: yield* proposals.record(source),
        second: yield* proposals.record(source),
      };
    }).pipe(withActor(caller))
  );

  expect(first.recorded).toBe(true);
  expect(second.recorded).toBe(false);
  expect(second.proposal.id).toBe(first.proposal.id);
});

test("the same file edited is a new request, because the run asked for something else", async () => {
  const { first, second } = await runtime.runPromise(
    Effect.gen(function* () {
      const proposals = yield* ProposalRepo;
      return {
        first: yield* proposals.record(
          proposalOf({ body: "Version one.", sourcePath: "edited.md" })
        ),
        second: yield* proposals.record(
          proposalOf({ body: "Version two.", sourcePath: "edited.md" })
        ),
      };
    }).pipe(withActor(caller))
  );

  expect(second.recorded).toBe(true);
  expect(second.proposal.id).not.toBe(first.proposal.id);
});

test("accepting stamps the person and the moment, and says so in the log", async () => {
  const { accepted, entries } = await runtime.runPromise(
    Effect.gen(function* () {
      const proposals = yield* ProposalRepo;
      const written = yield* proposals.record(
        proposalOf({ body: "Accepted rules.", sourcePath: "accept.md" })
      );
      const answer = yield* proposals
        .accept({ decidedBy: decider, id: written.proposal.id, workspaceId })
        .pipe(withActor({ kind: "human", userId: decider }));
      return { accepted: answer, entries: yield* auditFor(answer.id) };
    }).pipe(withActor(caller))
  );

  expect(accepted.state).toBe("accepted");
  expect(accepted.decidedBy).toBe(decider);
  expect(accepted.decidedAt).not.toBeNull();
  // Two rows: the run's request, and the person's answer under their own name.
  expect(entries.map((row) => row.action)).toEqual(["create", "update"]);
  expect(entries[1]?.actor_kind).toBe("human");
  expect(entries[1]?.actor_user_id).toBe(decider);
});

test("rejecting is a decision too, and writes the same stamp", async () => {
  const rejected = await runtime.runPromise(
    Effect.gen(function* () {
      const proposals = yield* ProposalRepo;
      const written = yield* proposals.record(
        proposalOf({ body: "Refused rules.", sourcePath: "reject.md" })
      );
      return yield* proposals
        .reject({ decidedBy: decider, id: written.proposal.id, workspaceId })
        .pipe(withActor({ kind: "human", userId: decider }));
    }).pipe(withActor(caller))
  );

  expect(rejected.state).toBe("rejected");
  expect(rejected.decidedBy).toBe(decider);
});

test("a second answer is refused rather than overwriting the first", async () => {
  const outcome = await runtime.runPromise(
    Effect.gen(function* () {
      const proposals = yield* ProposalRepo;
      const written = yield* proposals.record(
        proposalOf({ body: "Answered once.", sourcePath: "twice.md" })
      );
      const decision = {
        decidedBy: decider,
        id: written.proposal.id,
        workspaceId,
      };
      yield* proposals.accept(decision);
      return yield* proposals.reject(decision);
    }).pipe(
      withActor({ kind: "human", userId: decider }),
      Effect.exit,
      Effect.map((exit) =>
        exit._tag === "Failure" ? Cause.squash(exit.cause) : "no failure"
      )
    )
  );

  expect(outcome).toMatchObject({ _tag: "ProposalRepo.AlreadyDecided" });
});

test("a task's proposals come back newest first, decided ones included", async () => {
  const rows = await runtime.runPromise(
    Effect.gen(function* () {
      const proposals = yield* ProposalRepo;
      return yield* proposals.listByTask({ taskId: task.id, workspaceId });
    }).pipe(withActor(caller))
  );

  expect(rows.length).toBeGreaterThanOrEqual(6);
  expect(rows.some((row) => row.state === "accepted")).toBe(true);
  expect(rows.some((row) => row.state === "pending")).toBe(true);
});
