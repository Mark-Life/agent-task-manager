import {
  mutationOptions,
  type QueryKey,
  queryOptions,
} from "@tanstack/react-query";
import type { Effect } from "effect";
import { type ApiClient, type ApiClientShape, call, run } from "@/api/runtime";

/**
 * Bridge one effect into a query.
 *
 * The failure channel is threaded through as the query's error type, so
 * `query.error` arrives as the endpoint's own tagged union and a component can
 * branch on `_tag` instead of pattern-matching a message. React Query's abort
 * signal is handed to the runtime, which interrupts the fiber when a query is
 * cancelled or a component unmounts mid-flight.
 */
export const effectQuery = <A, E, const K extends QueryKey>(
  queryKey: K,
  effect: Effect.Effect<A, E, ApiClient>
) =>
  queryOptions<A, E, A, K>({
    queryFn: ({ signal }) => run(effect, signal),
    queryKey,
  });

/**
 * The same bridge for the common case: one call against the typed client.
 *
 * Almost every read is `client.<group>.<endpoint>(...)`, and writing that as a
 * generator only to yield the client back adds noise. Identical semantics to
 * {@link effectQuery} — same error typing, same cancellation.
 */
export const apiQuery = <A, E, const K extends QueryKey>(
  queryKey: K,
  f: (client: ApiClientShape) => Effect.Effect<A, E>
) =>
  queryOptions<A, E, A, K>({
    queryFn: ({ signal }) => call(f, signal),
    queryKey,
  });

/**
 * Bridge an effect-producing function into a mutation function.
 *
 * Deliberately just the function: callers pair it with their own optimistic
 * `onMutate` and rollback, which are the interesting parts of a mutation and
 * differ per endpoint. No abort signal is forwarded — a write that has left the
 * browser should finish even if the component that started it goes away.
 */
export const effectMutationFn =
  <A, E, V>(f: (variables: V) => Effect.Effect<A, E, ApiClient>) =>
  (variables: V) =>
    run(f(variables));

/**
 * The mutation counterpart of {@link apiQuery}, carrying the error type.
 *
 * Spread it into `useMutation` and the declared failures survive into
 * `mutation.error`, which is what lets a refused transition render its own
 * reason rather than a generic toast.
 */
export const apiMutation = <A, E, V>(
  f: (variables: V, client: ApiClientShape) => Effect.Effect<A, E>
) =>
  mutationOptions<A, E, V>({
    mutationFn: (variables: V) => call((client) => f(variables, client)),
  });
