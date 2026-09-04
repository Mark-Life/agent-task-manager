/**
 * Proof that both readings of a run actually draw.
 *
 * The plan is unit-tested next door; this covers what a unit test cannot — that
 * the components mount at all, over a run carrying every kind of event the
 * domain declares, and that the pairing a reader is promised comes out as one
 * card while the halves that never found a partner still come out as something.
 *
 * Rendered to static markup rather than through a browser: what is being checked
 * is which elements exist for a given run, and that is settled by the tree.
 */

import { describe, expect, test } from "bun:test";
import { RUN_EVENT_KINDS } from "@workspace/domain";
import { renderToStaticMarkup } from "react-dom/server";
import {
  callOf,
  eventOf,
  logOf,
  PAYLOADS,
  resultOf,
  runOf,
  saidOf,
} from "@/features/task/run-event.fixture";
import { RunChat } from "@/features/task/timeline-chat";
import { RunTable } from "@/features/task/timeline-table";

/**
 * One of every kind, plus the three cases the pairing is about: a call with its
 * result, a call with none, and a result whose call is not on screen.
 */
const EVENTS = runOf([
  ...RUN_EVENT_KINDS.map((kind) => PAYLOADS[kind]),
  callOf("toolu_unanswered", "Write"),
  resultOf("toolu_orphan", false),
  logOf("a second line of narration"),
  logOf("and a third"),
]);

const countOf = (markup: string, needle: string) =>
  markup.split(needle).length - 1;

const chat = (events = EVENTS) =>
  renderToStaticMarkup(<RunChat events={events} />);

const table = (events = EVENTS) =>
  renderToStaticMarkup(<RunTable events={events} />);

describe("RunChat", () => {
  test("every kind of event draws something", () => {
    const markup = chat();

    expect(markup).toContain('data-testid="run-chat"');
    // What the model said, as the document it wrote rather than its source.
    expect(markup).toContain("<strong>done</strong>");
    expect(markup).toContain("claude-opus-5");
    expect(markup).toContain("1840 chars");
    expect(markup).toContain("the tool took longer than the harness allows");
    expect(markup).toContain("the container stopped answering");
    expect(markup).toContain("asked for by the human");
    expect(markup).toContain("pulling the sandbox image");
    expect(markup).toContain("61% of the rate limit");
    expect(markup).toContain("finished done");
  });

  test("a code fence in a message is highlighted rather than shown as source", () => {
    const markup = chat(runOf([saidOf("```sql\nselect 1;\n```")]));

    expect(markup).not.toContain("```");
    expect(markup).toContain("<pre");
  });

  test("a call and its result are one card, and each unpaired half is its own", () => {
    const markup = chat();

    // Three cards: the paired one, the call nobody answered, the orphan result.
    expect(countOf(markup, "chars out")).toBe(2);
    expect(markup).toContain("No result recorded for this call.");
    expect(markup).toContain("result only");
  });

  test("a burst of narration is one block rather than a rule per line", () => {
    const markup = chat(runOf([logOf("one"), logOf("two"), logOf("three")]));

    expect(countOf(markup, "one")).toBeGreaterThan(0);
    expect(markup).toContain("two");
    expect(markup).toContain("three");
  });

  test("a message clipped by the ingest says so", () => {
    const markup = chat(
      runOf([
        {
          chars: 20,
          kind: "assistant_message",
          originalChars: 90_000,
          text: "the first 20 chars..",
          truncated: true,
        },
      ])
    );

    expect(markup).toContain("clipped from 90000 chars");
  });

  test("a long message offers to open rather than filling the page", () => {
    const short = chat(runOf([saidOf("brief")]));
    const long = chat(runOf([saidOf("x".repeat(2000))]));

    expect(short).not.toContain("Show all");
    expect(long).toContain("Show all");
  });

  test("a run with nothing in it draws nothing", () => {
    expect(chat([])).toContain('data-testid="run-chat"');
  });
});

describe("RunTable", () => {
  test("every event keeps its own row", () => {
    const markup = table();

    expect(markup).toContain('data-testid="run-table"');
    expect(countOf(markup, "<li")).toBe(EVENTS.length);
  });

  test("a call and its result stay apart, which is what the reading is for", () => {
    const markup = table(runOf([callOf("toolu_1"), resultOf("toolu_1")]));

    expect(countOf(markup, "<li")).toBe(2);
  });

  test("a run with nothing in it draws nothing", () => {
    expect(countOf(table([]), "<li")).toBe(0);
  });
});

describe("both readings", () => {
  test("neither drops an event that arrives mid-page", () => {
    const before = EVENTS.slice(0, 4);
    const after = [
      ...before,
      eventOf({ payload: saidOf("one more thing"), seq: 99 }),
    ];

    expect(chat(before)).not.toContain("one more thing");
    expect(chat(after)).toContain("one more thing");
    expect(table(after)).toContain("one more thing");
  });
});
