/**
 * The confirm path, against a real database and a real directory, because the
 * claim is that a person's click puts bytes into a folder every later run reads.
 *
 * Nothing is mocked. A fake filesystem would agree with a writer aiming at the
 * wrong directory, and the wrong directory is the whole question here: a
 * proposal into the workspace scope has to land in the global artifacts folder,
 * which is the read-only mount a worker could not write, and a proposal into a
 * project has to land in that project's.
 *
 * The refusals are the other half. A proposal whose recorded path climbs out of
 * its scope is refused at the moment of writing rather than trusted because the
 * parser once looked at it, and a rejection writes nothing at all — a reject
 * that quietly wrote the file would be the most expensive possible bug in this
 * design.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import type { PrincipalShape } from "@workspace/api";
import {
  AgentSessionRepo,
  CurrentActor,
  ProjectRepo,
  ProposalRepo,
  RunRepo,
  storeLayer,
  TaskRepo,
  withActor,
} from "@workspace/db";
import { ensureFixtureWorkspace } from "@workspace/db/testing";
import type {
  Project,
  Proposal,
  ProposalPath,
  Run,
  Task,
  WorkspaceId,
} from "@workspace/domain";
import { Actor, UserId } from "@workspace/domain";
import {
  globalArtifactsDirOf,
  projectArtifactsDirOf,
} from "@workspace/sandbox";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  confirmProposal,
  listTaskProposals,
  rejectProposal,
} from "./proposals";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "gateway-proposals-test";

const seeder = Actor.cases.system.make({ reason: APPLICATION_NAME });

/** The person answering. Only a person reaches these routes at all. */
const person = {
  kind: "human",
  userId: UserId.make(APPLICATION_NAME),
} as const;

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    storeLayer({ applicationName: APPLICATION_NAME }),
    BunFileSystem.layer,
    CurrentActor.layer(seeder)
  )
);

let dataRoot: string;
let workspaceId: WorkspaceId;
let project: Project;
let run: Run;
let task: Task;
let principal: PrincipalShape;

/** The digest the collector records, algorithm prefix and all. */
const digestOf = (body: string) =>
  `sha256:${createHash("sha256").update(body).digest("hex")}`;

/** A pending proposal, recorded the way the collector records one. */
const proposalWith = (input: {
  readonly body: string;
  readonly path: string;
  readonly scope: "project" | "workspace";
  readonly sourcePath: string;
}) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const proposals = yield* ProposalRepo;
      const written = yield* proposals.record({
        body: input.body,
        contentHash: digestOf(input.sourcePath + input.body),
        path: input.path as ProposalPath,
        projectId: input.scope === "project" ? project.id : null,
        runId: run.id,
        scope: input.scope,
        sourcePath: input.sourcePath,
        taskId: task.id,
        workspaceId,
      });
      return written.proposal;
    }).pipe(withActor(seeder))
  );

/** The confirm a person's click makes, as an effect the failing tests can flip. */
const confirming = (proposal: Proposal) =>
  confirmProposal({
    dataRoot,
    principal,
    proposalId: proposal.id,
    taskId: task.id,
  });

const confirm = (proposal: Proposal) =>
  runtime.runPromise(confirming(proposal));

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "gateway-proposals-"));

  const built = await runtime.runPromise(
    Effect.gen(function* () {
      const { workspace } = yield* ensureFixtureWorkspace({
        suite: APPLICATION_NAME,
      });
      const scope = workspace.id;
      const projects = yield* ProjectRepo;
      const tasks = yield* TaskRepo;
      const made = yield* projects.create({
        name: "proposals: the endpoints",
        workspaceId: scope,
      });
      const card = yield* tasks.create({
        projectId: made.id,
        title: "proposals: confirm and reject",
        workspaceId: scope,
      });
      const sessions = yield* AgentSessionRepo;
      const runs = yield* RunRepo;
      const subject = { id: card.id, kind: "task" } as const;
      const session = yield* sessions.open({
        provider: "claude",
        subject,
        workspaceId: scope,
      });
      const attempt = yield* runs.create({
        agentSessionId: session.id,
        provider: "claude",
        subject,
        trigger: "status_change",
        workspaceId: scope,
      });
      return {
        attempt,
        card,
        made,
        workspaceId: scope,
      };
    }).pipe(withActor(seeder))
  );

  ({ workspaceId } = built);
  project = built.made;
  run = built.attempt;
  task = built.card;
  principal = { actor: person, scope: "admin", workspaceId };
});

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      const projects = yield* ProjectRepo;
      yield* tasks.delete({ id: task.id, workspaceId });
      yield* projects.delete({ id: project.id, workspaceId });
    }).pipe(withActor(person))
  );
  await runtime.dispose();
  rmSync(dataRoot, { force: true, recursive: true });
});

test("confirming writes the recorded body into the workspace scope", async () => {
  const body = "# House style\n\nPrefer a short comment with a link.\n";
  const accepted = await confirm(
    await proposalWith({
      body,
      path: "CLAUDE.md",
      scope: "workspace",
      sourcePath: ".atm/proposals/house.md",
    })
  );

  expect(accepted.state).toBe("accepted");
  expect(accepted.decidedBy).toBe(person.userId);
  // The read-only mount a worker could not write, written by a person's click.
  expect(
    readFileSync(join(globalArtifactsDirOf(dataRoot), "CLAUDE.md"), "utf8")
  ).toBe(body);
});

test("a project proposal lands in that project's directory and nowhere else", async () => {
  const body = "Review twice before merging.";
  await confirm(
    await proposalWith({
      body,
      path: "docs/conventions.md",
      scope: "project",
      sourcePath: ".atm/proposals/conventions.md",
    })
  );

  expect(
    readFileSync(
      join(
        projectArtifactsDirOf({ dataRoot, projectId: project.id }),
        "docs/conventions.md"
      ),
      "utf8"
    )
  ).toBe(body);
  expect(
    existsSync(join(globalArtifactsDirOf(dataRoot), "docs/conventions.md"))
  ).toBe(false);
});

test("rejecting records the decision and writes nothing", async () => {
  const proposal = await proposalWith({
    body: "Never review anything.",
    path: "REFUSED.md",
    scope: "workspace",
    sourcePath: ".atm/proposals/refused.md",
  });

  const rejected = await runtime.runPromise(
    rejectProposal({
      dataRoot,
      principal,
      proposalId: proposal.id,
      taskId: task.id,
    })
  );

  expect(rejected.state).toBe("rejected");
  expect(rejected.decidedBy).toBe(person.userId);
  expect(existsSync(join(globalArtifactsDirOf(dataRoot), "REFUSED.md"))).toBe(
    false
  );
});

test("a second answer is refused, so nobody overwrites a decision", async () => {
  const proposal = await proposalWith({
    body: "Answered once.",
    path: "ONCE.md",
    scope: "workspace",
    sourcePath: ".atm/proposals/once.md",
  });
  await confirm(proposal);

  const again = await runtime.runPromise(Effect.flip(confirming(proposal)));

  expect(again._tag).toBe("ProposalAlreadyDecided");
});

/**
 * The row can never hold such a path in the first place: the insert encodes
 * through the same brand the parser produced, so a hand-written row is refused
 * by the store rather than discovered by the writer.
 */
test("the store refuses to record a path that climbs out of its scope", async () => {
  const refusal = await runtime.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const proposals = yield* ProposalRepo;
        return yield* proposals.record({
          body: "somewhere else entirely",
          contentHash: `sha256:${"e".repeat(64)}`,
          path: "../escaped.md" as ProposalPath,
          projectId: null,
          runId: run.id,
          scope: "workspace",
          sourcePath: ".atm/proposals/escape.md",
          taskId: task.id,
          workspaceId,
        });
      }).pipe(withActor(seeder))
    )
  );

  expect(refusal._tag).toBe("Db.InvalidInput");
  expect(existsSync(join(globalArtifactsDirOf(dataRoot), "escaped.md"))).toBe(
    false
  );
});

/**
 * The check the pure rule cannot make. An earlier accepted proposal, or an
 * operator, can leave a symlink in a shared scope, and a path built entirely of
 * ordinary segments still lands outside the directory when one of them is a link
 * — so the parent is resolved through its links before anything is written.
 */
test("a symlink in the scope does not carry a confirm outside it", async () => {
  const outside = mkdtempSync(join(tmpdir(), "gateway-proposals-outside-"));
  mkdirSync(globalArtifactsDirOf(dataRoot), { recursive: true });
  symlinkSync(outside, join(globalArtifactsDirOf(dataRoot), "elsewhere"));

  const refusal = await runtime.runPromise(
    Effect.flip(
      confirming(
        await proposalWith({
          body: "planted",
          path: "elsewhere/rules.md",
          scope: "workspace",
          sourcePath: ".atm/proposals/planted.md",
        })
      )
    )
  );

  expect(refusal._tag).toBe("Forbidden");
  expect(existsSync(join(outside, "rules.md"))).toBe(false);
  rmSync(outside, { force: true, recursive: true });
});

/**
 * The same attack one segment shorter, which a check of the parent alone lets
 * through: the link is the file being written, so its parent is the scope root
 * and every question about the parent answers "inside". The run that proposed
 * the path is the run that could have planted the link.
 */
test("a link that is itself the file does not carry a confirm outside it", async () => {
  const outside = mkdtempSync(join(tmpdir(), "gateway-proposals-direct-"));
  const dir = globalArtifactsDirOf(dataRoot);
  mkdirSync(dir, { recursive: true });
  symlinkSync(join(outside, "pointed.md"), join(dir, "pointed.md"));

  const refusal = await runtime.runPromise(
    Effect.flip(
      confirming(
        await proposalWith({
          body: "planted",
          path: "pointed.md",
          scope: "workspace",
          sourcePath: ".atm/proposals/pointed.md",
        })
      )
    )
  );

  expect(refusal._tag).toBe("Forbidden");
  expect(existsSync(join(outside, "pointed.md"))).toBe(false);
  rmSync(outside, { force: true, recursive: true });
});

/**
 * The scope's history is the record of what every run and every person changed
 * to the rules the next run reads. A `.git` segment is refused in the path a
 * proposal carries, and a link is the way around that refusal — so where the
 * write really lands is asked as well as what it was called.
 */
test("a link to the object store does not carry a confirm into it", async () => {
  const dir = globalArtifactsDirOf(dataRoot);
  mkdirSync(join(dir, ".git"), { recursive: true });
  symlinkSync(".git", join(dir, "record"));

  const refusal = await runtime.runPromise(
    Effect.flip(
      confirming(
        await proposalWith({
          body: "planted",
          path: "record/description",
          scope: "workspace",
          sourcePath: ".atm/proposals/record.md",
        })
      )
    )
  );

  expect(refusal._tag).toBe("Forbidden");
  expect(existsSync(join(dir, ".git/description"))).toBe(false);
});

test("a task's proposals list newest first, decided ones included", async () => {
  const rows = await runtime.runPromise(
    listTaskProposals({ dataRoot, principal, taskId: task.id })
  );

  // Three confirms above were refused their path, and a write that could not
  // land is not a decision anybody made: each is still waiting for one.
  expect(rows.filter((row) => row.state === "pending")).toHaveLength(3);
  expect(rows.some((row) => row.state === "accepted")).toBe(true);
  expect(rows.some((row) => row.state === "rejected")).toBe(true);
});
