import { queryOptions } from "@tanstack/react-query";
import { keys } from "@/api/keys";
import { apiQuery } from "@/api/query";

/**
 * How often the browser re-reads the published reading.
 *
 * The endpoint serves a file the loop rewrites every five minutes, so there is
 * nothing to gain from asking faster than the numbers change — and something to
 * lose, since a poll on the same period as the write shows a reading that can be
 * ten minutes old by the time it is replaced. Two minutes is the middle of that:
 * two or three reads of a small local file per publish, and a figure on screen
 * that is never much older than the one the gate is deciding with. The reading's
 * own age is rendered beside it either way, so nobody has to trust this number.
 */
const POLL_INTERVAL_MS = 120_000;

/**
 * What is left in both subscriptions.
 *
 * One key for the whole app: the allowance belongs to the machine's provider
 * logins rather than to a workspace, so every screen that asks is asking the
 * same question and shares one in-flight request. Kept fresh for as long as the
 * poll period, which stops a remount costing a request the poll was about to
 * make anyway.
 */
export const usageQuery = () =>
  queryOptions({
    ...apiQuery(keys.usage(), (client) => client.usage.get()),
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: POLL_INTERVAL_MS,
  });
