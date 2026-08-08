/**
 * What is left in the provider subscriptions, on the wire.
 *
 * The domain's shape unchanged, because there is only one reading and it is not
 * the gateway's: the loop polls the providers and publishes it, the gateway
 * serves what it finds. A second shape here would be a second answer to "how
 * much is left", assembled by a process that never looked.
 */

import { ProviderUsageSnapshot as DomainSnapshot } from "@workspace/domain";

/** Every governed provider's remaining allowance, as of the loop's last read. */
export const ProviderUsageSnapshot = DomainSnapshot;

export type ProviderUsageSnapshot = typeof DomainSnapshot.Type;
