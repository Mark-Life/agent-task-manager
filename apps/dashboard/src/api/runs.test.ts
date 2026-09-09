/**
 * What a live run's timeline does with an event that arrives while it is open.
 *
 * The screen used to re-read the last page every three seconds, which made this
 * question the server's: a refetch replaced the page whole and could not be
 * wrong about order or duplicates. A held stream moves the question here, and
 * the two answers it has to get right are both about a connection that dropped
 * and was reopened — a replayed event must not appear twice, and the paging
 * that would fetch the same tail must stop where the stream took over.
 *
 * Pure, so this is a test and not a screenshot: nothing here needs a socket, a
 * cache or a rendered component.
 */

import { describe, expect, test } from "bun:test";
import type { InfiniteData } from "@tanstack/react-query";
import type { RunEvent } from "@workspace/api";
import { appendEvent } from "@/api/runs";
import { eventOf, logOf } from "@/features/task/run-event.fixture";

/** A page of a timeline, as the paged endpoint answers one. */
interface Page {
  readonly events: readonly RunEvent[];
  readonly nextSeq: number | null;
}

const pagesOf = (...pages: readonly Page[]): InfiniteData<Page> => ({
  pageParams: pages.map((_, index) => index),
  pages: [...pages],
});

const said = (seq: number) => eventOf({ payload: logOf(`line ${seq}`), seq });

const seqsIn = (data: InfiniteData<Page> | undefined) =>
  data?.pages.flatMap((page) => page.events.map((event) => event.seq)) ?? [];

describe("appendEvent", () => {
  test("puts an arriving event at the end of the last page", () => {
    const data = pagesOf({ events: [said(0), said(1)], nextSeq: null });

    expect(seqsIn(appendEvent(data, said(2)))).toEqual([0, 1, 2]);
  });

  test("drops one it already has, however many times it arrives", () => {
    const data = pagesOf({ events: [said(0), said(1)], nextSeq: null });

    const once = appendEvent(data, said(1));
    const twice = appendEvent(once, said(0));

    expect(seqsIn(twice)).toEqual([0, 1]);
    // The same object back, so a replay after a reconnect does not re-render
    // the timeline somebody is reading.
    expect(once).toBe(data);
  });

  test("closes the page it appends to, so paging does not fetch the tail twice", () => {
    const data = pagesOf({ events: [said(0)], nextSeq: 0 });

    expect(appendEvent(data, said(1))?.pages.at(-1)?.nextSeq).toBeNull();
  });

  test("leaves the pages before the last one alone", () => {
    const data = pagesOf(
      { events: [said(0)], nextSeq: 0 },
      { events: [said(1)], nextSeq: 1 }
    );

    const grown = appendEvent(data, said(2));

    expect(grown?.pages[0]).toBe(data.pages[0]);
    expect(seqsIn(grown)).toEqual([0, 1, 2]);
  });

  test("has nothing to append to before the first page has arrived", () => {
    expect(appendEvent(undefined, said(0))).toBeUndefined();
  });
});
