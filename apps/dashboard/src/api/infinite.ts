import {
  type InfiniteData,
  infiniteQueryOptions,
  type QueryKey,
} from "@tanstack/react-query";
import type { Effect } from "effect";
import { type ApiClientShape, call } from "@/api/runtime";

/**
 * Bridge a cursor-paged endpoint into an infinite query.
 *
 * The same job the single-read bridge does, with the cursor threaded
 * through: the request is written once as a function of the cursor, and the
 * failure type survives into `query.error` so a paged screen narrows on `_tag`
 * like every other. A page function that answers `undefined` is the end of what
 * exists, which react-query reads as "no next page".
 */
export const apiInfiniteQuery = <A, E, P, const K extends QueryKey>(options: {
  readonly cursorOf: (page: A) => P | undefined;
  readonly from: P;
  readonly queryKey: K;
  readonly request: (cursor: P, client: ApiClientShape) => Effect.Effect<A, E>;
}) =>
  infiniteQueryOptions<A, E, InfiniteData<A>, K, P>({
    getNextPageParam: options.cursorOf,
    initialPageParam: options.from,
    // The cursor's type is decided by a conditional react-query cannot resolve
    // while the page type is still a variable, so it arrives here as `unknown`.
    // It is the value handed to `initialPageParam` or returned by `cursorOf`,
    // both of which are typed; at every call site the conditional does resolve.
    queryFn: ({ pageParam, signal }) =>
      call((client) => options.request(pageParam as P, client), signal),
    queryKey: options.queryKey,
  });
