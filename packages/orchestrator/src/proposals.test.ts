/**
 * That a request to change a shared directory is understood, and that a request
 * to change something else is refused.
 *
 * The parser is tested against garbage on purpose. The file arrives from a model
 * that has just read an untrusted repository, so "what does this do with input
 * nobody meant" is the behaviour rather than an edge case: every shape below is
 * one a real run produces — a note dropped in the folder, front matter that
 * never closes, a quoted path, a header with no body — and none of them may be
 * the thing that decides what gets written into the rules every later run reads.
 *
 * The path cases are the reason the module exists. `../`, a leading `/` and a
 * `.git` segment each reach out of the scope the proposal declared, and a
 * parser that repaired them instead of refusing them would be an untrusted
 * repository editing whatever it liked one accept later.
 *
 * The collector runs against a real directory, because the claim is about where
 * it looks: the task's own artifacts folder, under the name the prompt tells the
 * agent to write. A stub would agree with a reader looking in the wrong place.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { PROPOSALS_DIRNAME, TaskId } from "@workspace/domain";
import { taskArtifactsDirOf } from "@workspace/sandbox";
import { Effect, Logger } from "effect";
import {
  type ProposalParse,
  parseProposal,
  proposalsDirOf,
  readProposals,
} from "./proposals";

/** The target path a parse produced, unbranded, or null where it refused one. */
const pathOf = (parse: ProposalParse) =>
  parse.kind === "proposal" ? String(parse.proposal.path) : null;

/** The digest a collected proposal carries, algorithm prefix and all. */
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;

const dataRoot = mkdtempSync(join(tmpdir(), "atm-proposals-test-"));

afterAll(() => {
  rmSync(dataRoot, { force: true, recursive: true });
});

/** What a run that wants the house style changed actually writes. */
const HOUSE_RULES = `---
scope: workspace
path: CLAUDE.md
---
# House style

Prefer a short comment with a link over a long one without.`;

describe("parseProposal", () => {
  test("reads the scope, the path and the body a run wrote", () => {
    const parsed = parseProposal(HOUSE_RULES);

    expect(parsed.kind).toBe("proposal");
    if (parsed.kind !== "proposal") {
      return;
    }
    expect(parsed.proposal.scope).toBe("workspace");
    expect(String(parsed.proposal.path)).toBe("CLAUDE.md");
    expect(parsed.proposal.body).toContain("# House style");
    // The fences and the header are not part of what gets written.
    expect(parsed.proposal.body).not.toContain("scope:");
  });

  test("takes a project proposal, which is the other directory a run shares", () => {
    const parsed = parseProposal(
      "---\nscope: project\npath: docs/conventions.md\n---\nOne test per behaviour."
    );

    expect(parsed.kind === "proposal" && parsed.proposal.scope).toBe("project");
  });

  // A model writing YAML quotes about half the time, and a path wrapped in
  // quotation marks fails every check for a reason nobody reading it can see.
  test("strips the quotes a model puts round a value", () => {
    const parsed = parseProposal(
      '---\nscope: "workspace"\npath: "manager/CLAUDE.md"\n---\nAnswer in one paragraph.'
    );

    expect(pathOf(parsed)).toBe("manager/CLAUDE.md");
  });

  test("survives a leading blank line and windows line endings", () => {
    const parsed = parseProposal(
      "\r\n---\r\nscope: workspace\r\npath: AGENTS.md\r\n---\r\nUse the shortest word.\r\n"
    );

    expect(pathOf(parsed)).toBe("AGENTS.md");
  });

  const refused = [
    ["a note somebody left in the folder", "Remember to ask about the vault."],
    ["an empty file", ""],
    ["front matter that never closes", "---\nscope: workspace\npath: a.md\n"],
    ["a header naming no scope", "---\npath: CLAUDE.md\n---\nWords."],
    ["a header naming no path", "---\nscope: workspace\n---\nWords."],
    [
      "a scope that is not one of the two",
      "---\nscope: repo\npath: README.md\n---\nWords.",
    ],
    [
      "a proposal with nothing in it",
      "---\nscope: workspace\npath: CLAUDE.md\n---\n\n \n",
    ],
  ] as const;

  for (const [what, text] of refused) {
    test(`refuses ${what}`, () => {
      expect(parseProposal(text).kind).toBe("refused");
    });
  }

  const escapes = [
    ["climbs out with ..", "../../../etc/agents.md"],
    ["names an absolute path", "/etc/passwd"],
    ["reaches the scope's own history", ".git/hooks/pre-commit"],
    ["reaches a history further down", "vendor/.git/config"],
  ] as const;

  for (const [what, path] of escapes) {
    test(`refuses a path that ${what}`, () => {
      const parsed = parseProposal(
        `---\nscope: workspace\npath: ${path}\n---\nAnything at all.`
      );

      expect(parsed).toEqual({ kind: "refused", refusal: "bad_path" });
    });
  }
});

let next = 0;

/** A task whose run left these files in its proposals directory. */
const taskWith = (files: Readonly<Record<string, string>>) => {
  next += 1;
  const taskId = TaskId.make(
    `0199b000-0000-7000-8000-00000000000${next.toString(16)}`
  );
  const directory = proposalsDirOf({ dataRoot, taskId });
  mkdirSync(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents);
  }
  return taskId;
};

/**
 * Collects the lines a refusal leaves behind. A dropped proposal is invisible
 * in the return value by construction, so the log is the only place the
 * difference between "refused" and "never written" shows — which is why the
 * tests below read it rather than silencing it.
 */
const refusals: string[] = [];
const refusalLogger = Logger.layer([
  Logger.make(({ message }) => {
    const first = Array.isArray(message) ? message[0] : message;
    if (typeof first === "string" && first.startsWith("proposal ")) {
      refusals.push(first);
    }
  }),
]);

const collect = (taskId: TaskId, hasProject = true) =>
  Effect.runPromise(
    readProposals({ dataRoot, hasProject, taskId }).pipe(
      Effect.provide(BunFileSystem.layer),
      Effect.provide(refusalLogger)
    )
  );

describe("readProposals", () => {
  test("collects what a run left, naming the file it came out of", async () => {
    const collected = await collect(taskWith({ "house.md": HOUSE_RULES }));

    expect(collected).toHaveLength(1);
    expect(collected[0]?.scope).toBe("workspace");
    expect(String(collected[0]?.path)).toBe("CLAUDE.md");
    expect(collected[0]?.sourcePath).toBe(join(PROPOSALS_DIRNAME, "house.md"));
    expect(collected[0]?.contentHash).toMatch(CONTENT_HASH);
  });

  test("looks inside the task's own artifacts directory and nowhere else", () => {
    const taskId = TaskId.make("0199b000-0000-7000-8000-0000000000ff");

    expect(proposalsDirOf({ dataRoot, taskId })).toBe(
      join(taskArtifactsDirOf({ dataRoot, taskId }), PROPOSALS_DIRNAME)
    );
  });

  test("answers nothing for the ordinary run, which proposes none", async () => {
    expect(
      await collect(TaskId.make("0199b000-0000-7000-8000-0000000000fe"))
    ).toEqual([]);
  });

  // One bad file must not take the good ones with it: the run is already over,
  // and a refusal is about that proposal rather than about the run.
  test("keeps the proposals it understood beside the ones it refused", async () => {
    refusals.length = 0;
    const collected = await collect(
      taskWith({
        "escape.md": "---\nscope: workspace\npath: ../../x.md\n---\nNo.",
        "good.md": HOUSE_RULES,
        "notes.md": "Just a note.",
      })
    );

    expect(collected.map((one) => one.sourcePath)).toEqual([
      join(PROPOSALS_DIRNAME, "good.md"),
    ]);
    // Refused and said so. A proposal that vanished silently would be
    // indistinguishable from a run that never wrote one.
    expect(refusals).toEqual(["proposal refused", "proposal refused"]);
  });

  test("reads only markdown, so a scratch file beside a proposal is not one", async () => {
    const collected = await collect(
      taskWith({ "draft.txt": HOUSE_RULES, "real.md": HOUSE_RULES })
    );

    expect(collected).toHaveLength(1);
    expect(collected[0]?.sourcePath).toBe(join(PROPOSALS_DIRNAME, "real.md"));
  });

  // A run with no project directory is describing a place it never had, so
  // there is nothing for a person to accept and nothing to accept it into.
  test("refuses a project proposal from a run that had no project", async () => {
    const taskId = taskWith({
      "conventions.md":
        "---\nscope: project\npath: CLAUDE.md\n---\nReview twice.",
    });

    expect(await collect(taskId, false)).toEqual([]);
    expect(await collect(taskId, true)).toHaveLength(1);
  });

  test("leaves the file where it was, so the rescan still indexes it", async () => {
    // A proposal is a request *and* an artifact: a person deciding wants to open
    // what the agent actually wrote. Recording it twice is the store's problem,
    // and it recognises the same bytes.
    const taskId = taskWith({ "house.md": HOUSE_RULES });
    const first = await collect(taskId);
    const again = await collect(taskId);

    expect(again).toEqual(first);
  });
});
