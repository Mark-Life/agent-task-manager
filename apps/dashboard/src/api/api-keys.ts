import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createKey, listKeys, revokeKey } from "@/auth/api-key-client";

/**
 * A person's own API keys, as the cache holds them.
 *
 * These go to the auth library rather than to the gateway's contract — see
 * `@/auth/api-key-client` for why — so they are plain queries over that module
 * instead of the `apiQuery`/`apiMutation` pair every board read uses. The
 * library scopes each call to the session holder, so there is no user id in any
 * of them and no way to name somebody else's key.
 */

/** The one cache key. Keys are per-person and there is no second view of them. */
export const apiKeysKey = ["api-keys"] as const;

export type { IssuedKey, KeyRequest } from "@/auth/api-key-client";

/** Every key this person holds, newest first. */
export const useApiKeys = () =>
  useQuery({ queryFn: listKeys, queryKey: apiKeysKey });

/** Issue a key. What comes back is the only copy of the secret there will be. */
export const useCreateApiKey = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createKey,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: apiKeysKey }),
  });
};

/** Revoke a key. Immediate, and there is nothing to undo it with. */
export const useRevokeApiKey = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revokeKey,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: apiKeysKey }),
  });
};
