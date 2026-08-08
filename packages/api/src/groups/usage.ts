/**
 * How much subscription allowance is left, for both providers.
 *
 * One endpoint, and it is a read of a document rather than a query: the loop
 * holds the credentials and polls the providers on its own cadence, and this
 * serves whatever it last published. That is why there is no refresh verb — a
 * caller that could force a poll could force one per page load, against an
 * endpoint whose whole value is that it is passive and cheap.
 *
 * Not scoped to a workspace, unlike everything else on this surface. The
 * allowance belongs to the accounts the machine runs agents with, not to a
 * board: two workspaces on one host draw down the same five-hour window, and
 * pretending otherwise would show each of them a number the other is spending.
 * A credential is still required — what a machine has left is not a public fact
 * about it.
 */

import {
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import { ProviderUsageSnapshot } from "../schemas/usage";
import { ReadAccess } from "../security";

/**
 * The last reading. Answers 200 with an empty provider list where the loop has
 * never published — "nothing has looked yet" is a state worth rendering, and a
 * 404 would make a caller guess which of the two it was.
 */
const get = HttpApiEndpoint.get("get", "/usage", {
  success: ProviderUsageSnapshot,
})
  .middleware(ReadAccess)
  .annotate(OpenApi.Summary, "Remaining provider usage");

/** Remaining allowance on the accounts behind the runs. */
export class UsageGroup extends HttpApiGroup.make("usage")
  .add(get)
  .annotate(
    OpenApi.Description,
    "Remaining subscription allowance per provider, per rolling window, as of the loop's last read."
  ) {}
