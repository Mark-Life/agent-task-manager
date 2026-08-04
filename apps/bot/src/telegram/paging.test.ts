import { describe, expect, test } from "bun:test";
import { appendNavRow, navKeyboard, pageIndicator, paginate } from "./paging";

const items = Array.from({ length: 20 }, (_, i) => i);

/** The button labels of a keyboard, flattened — what a person actually sees. */
const labels = (keyboard: ReturnType<typeof navKeyboard>) =>
  keyboard.inline_keyboard.flat().map((button) => button.text);

/** The callback data of a keyboard, flattened. */
const data = (keyboard: ReturnType<typeof navKeyboard>) =>
  keyboard.inline_keyboard
    .flat()
    .map((button) => ("callback_data" in button ? button.callback_data : null));

describe("paginate", () => {
  test("slices the requested page", () => {
    const page = paginate({ items, page: 1, pageSize: 5 });
    expect(page.items).toEqual([5, 6, 7, 8, 9]);
    expect(page.totalPages).toBe(4);
  });

  test("clamps a page past the end rather than failing", () => {
    expect(paginate({ items, page: 99, pageSize: 5 }).page).toBe(3);
  });

  test("clamps a negative page", () => {
    expect(paginate({ items, page: -4, pageSize: 5 }).page).toBe(0);
  });

  test("reports an empty list as one empty page", () => {
    const page = paginate({ items: [], page: 0 });
    expect(page.isEmpty).toBe(true);
    expect(page.items).toEqual([]);
    expect(page.totalPages).toBe(1);
  });

  test("survives a pathological page size", () => {
    expect(paginate({ items, page: 0, pageSize: 0 }).pageSize).toBe(1);
  });
});

describe("pageIndicator", () => {
  test("is empty when there is only one page", () => {
    expect(pageIndicator({ page: 0, totalPages: 1 })).toBe("");
  });

  test("counts from one, because a reader does", () => {
    expect(pageIndicator({ page: 2, totalPages: 5 })).toBe(" (3/5)");
  });
});

describe("navKeyboard", () => {
  test("draws nothing when there is nowhere to go", () => {
    expect(
      navKeyboard({ key: "threads", page: { page: 0, totalPages: 1 } })
        .inline_keyboard
    ).toEqual([]);
  });

  test("draws only Next on the first page", () => {
    const keyboard = navKeyboard({
      key: "threads",
      page: { page: 0, totalPages: 3 },
    });
    expect(labels(keyboard)).toEqual(["Next ›"]);
    expect(data(keyboard)).toEqual(["v1:pg:threads:1"]);
  });

  test("draws only Prev on the last page", () => {
    const keyboard = navKeyboard({
      key: "history",
      page: { page: 2, totalPages: 3 },
    });
    expect(labels(keyboard)).toEqual(["‹ Prev"]);
    expect(data(keyboard)).toEqual(["v1:pg:history:1"]);
  });

  test("draws both in the middle", () => {
    const keyboard = navKeyboard({
      key: "tasks",
      page: { page: 1, totalPages: 3 },
    });
    expect(labels(keyboard)).toEqual(["‹ Prev", "Next ›"]);
  });
});

describe("appendNavRow", () => {
  test("keeps the rows already on the keyboard", () => {
    const keyboard = navKeyboard({
      key: "board",
      page: { page: 0, totalPages: 2 },
    });
    appendNavRow({ key: "board", keyboard, page: { page: 1, totalPages: 2 } });
    expect(keyboard.inline_keyboard).toHaveLength(2);
  });
});
