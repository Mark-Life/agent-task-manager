/**
 * Paging a list into one screen at a time, and the two buttons that move it.
 *
 * A phone shows about eight rows before the message starts scrolling under the
 * keyboard, and a Telegram message caps at 4096 characters regardless. So every
 * list this bot renders — threads, history, tasks, the board — is one page with
 * a *Prev* / *Next* row under it, and the page number rides in the callback
 * data rather than in any state this process holds. That is the point: a
 * restart between the render and the tap changes nothing, because the button
 * carries everything the re-render needs.
 *
 * The page index is *clamped*, not validated. A tap on a stale message can ask
 * for page 7 of a list that has since shrunk to three, and the honest answer is
 * the last page, not an error about a button that was correct when it was
 * drawn.
 *
 * Everything here is pure. The list comes from a repository or the gateway;
 * this file decides only which slice of it is on screen.
 */

import { InlineKeyboard } from "grammy";
import { encodeCallbackData, type PageKey } from "./callback-data";

/** Rows per page, sized to what a phone shows without scrolling. */
export const DEFAULT_PAGE_SIZE = 8;

/**
 * Slice a list into the page a button asked for.
 *
 * `page` is clamped into range and reported back, so the caller renders the
 * indicator and the nav row from the page it actually showed rather than the
 * one it was asked for.
 */
export const paginate = <A>(options: {
  readonly items: readonly A[];
  readonly page: number;
  readonly pageSize?: number;
}) => {
  const pageSize = Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(options.items.length / pageSize));
  const page = Math.max(0, Math.min(Math.trunc(options.page), totalPages - 1));
  return {
    isEmpty: options.items.length === 0,
    items: options.items.slice(page * pageSize, (page + 1) * pageSize),
    page,
    pageSize,
    totalItems: options.items.length,
    totalPages,
  };
};

/** What `paginate` reports, derived so a renderer's parameter cannot drift. */
export type Page<A> = ReturnType<typeof paginate<A>>;

/**
 * The ` (2/5)` a heading carries, or nothing when there is only one page.
 * A "1/1" is a control that tells the reader there is nothing to control.
 */
export const pageIndicator = (
  page: Pick<Page<unknown>, "page" | "totalPages">
) => (page.totalPages > 1 ? ` (${page.page + 1}/${page.totalPages})` : "");

/**
 * Append the *Prev* / *Next* row for a page to a keyboard, in place, and hand
 * the keyboard back so a builder can chain.
 *
 * Only the moves that exist are drawn. A disabled-looking button in Telegram is
 * an ordinary button that answers with nothing, which reads as a bot that hung.
 */
export const appendNavRow = (options: {
  readonly key: PageKey;
  readonly keyboard: InlineKeyboard;
  readonly page: Pick<Page<unknown>, "page" | "totalPages">;
}) => {
  const { key, keyboard, page } = options;
  const buttons = [
    ...(page.page > 0
      ? [
          InlineKeyboard.text(
            "‹ Prev",
            encodeCallbackData({
              key,
              kind: "page",
              page: page.page - 1,
              verb: "pg",
            })
          ),
        ]
      : []),
    ...(page.page < page.totalPages - 1
      ? [
          InlineKeyboard.text(
            "Next ›",
            encodeCallbackData({
              key,
              kind: "page",
              page: page.page + 1,
              verb: "pg",
            })
          ),
        ]
      : []),
  ];
  return buttons.length === 0 ? keyboard : keyboard.row(...buttons);
};

/**
 * A keyboard that is nothing but the nav row — the shape a plain text list
 * wants. Built from an empty row list rather than grammy's default, which seeds
 * one empty row and would leave it behind when there is nothing to draw.
 */
export const navKeyboard = (options: {
  readonly key: PageKey;
  readonly page: Pick<Page<unknown>, "page" | "totalPages">;
}) =>
  appendNavRow({
    key: options.key,
    keyboard: new InlineKeyboard([]),
    page: options.page,
  });
