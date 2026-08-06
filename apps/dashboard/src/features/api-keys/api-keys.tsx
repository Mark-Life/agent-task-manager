import {
  Delete02Icon,
  Key01Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ApiScope } from "@workspace/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@workspace/ui/components/alert-dialog";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@workspace/ui/components/item";
import { useCallback, useState } from "react";
import { type IssuedKey, useApiKeys, useRevokeApiKey } from "@/api/api-keys";
import { authClient } from "@/auth/client";
import { Failed, Pending } from "@/components/query-state";
import { KeyFormDialog } from "@/features/api-keys/key-form";

/** What each scope is called in a list, where there is room for two words. */
const SCOPE_NAMES: Record<ApiScope, string> = {
  admin: "Full access",
  read: "Read only",
  "task-write": "Read and write",
};

const formatDate = (value: Date) =>
  value.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/**
 * When a key was last used, or that it never has been.
 *
 * "Never used" is the useful sentence rather than a blank: a key that has never
 * authenticated anything is either one somebody forgot to wire up or one that
 * leaked and was never spent, and both are worth seeing at a glance.
 */
const lastUsedOf = (key: IssuedKey) =>
  key.lastRequest === null
    ? "Never used"
    : `Last used ${formatDate(key.lastRequest)}`;

const expiryOf = (key: IssuedKey) => {
  if (key.expiresAt === null) {
    return "Does not expire";
  }
  return key.expiresAt.getTime() < Date.now()
    ? "Expired"
    : `Expires ${formatDate(key.expiresAt)}`;
};

interface KeyRowProps {
  readonly apiKey: IssuedKey;
}

/**
 * One key, and the only two things worth knowing about it: what it may do, and
 * whether anything is still using it. Revoking is behind a confirmation because
 * it is immediate and there is nothing to undo it with.
 */
const KeyRow = ({ apiKey }: KeyRowProps) => {
  const revoke = useRevokeApiKey();
  const { mutate } = revoke;
  const confirm = useCallback(() => mutate(apiKey.id), [mutate, apiKey.id]);
  const label = apiKey.name ?? "Unnamed key";

  return (
    <Item variant="outline">
      <ItemContent>
        <ItemTitle className="flex items-center gap-2">
          {label}
          {apiKey.scope === null ? null : (
            <Badge variant="secondary">{SCOPE_NAMES[apiKey.scope]}</Badge>
          )}
        </ItemTitle>
        <ItemDescription>
          {apiKey.start === null ? null : (
            <span className="font-mono">{apiKey.start}… · </span>
          )}
          {lastUsedOf(apiKey)} · {expiryOf(apiKey)}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <AlertDialog>
          <AlertDialogTrigger
            render={
              <Button
                aria-label={`Revoke ${label}`}
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke “{label}”?</AlertDialogTitle>
              <AlertDialogDescription>
                Anything still using it stops working on its next request. The
                agents running on this board are unaffected — they hold a
                different credential. There is no undo.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep</AlertDialogCancel>
              <AlertDialogAction
                disabled={revoke.isPending}
                onClick={confirm}
                variant="destructive"
              >
                Revoke
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ItemActions>
    </Item>
  );
};

/**
 * Every key this person holds, and the whole of their lifecycle.
 *
 * The screen exists because a credential that can be created and not revoked is
 * worse than no credential at all — so the list, the last-used column and the
 * revoke button are the point of it, and creating one is the smaller half.
 *
 * The workspace comes from the session's active organization: a key speaks for
 * one board, the gateway checks that claim against the issuer's memberships on
 * every request, and recording it here is what makes a key usable without the
 * caller ever naming a workspace on the wire.
 */
export const ApiKeys = () => {
  const keys = useApiKeys();
  const active = authClient.useActiveOrganization();
  const workspaces = authClient.useListOrganizations();
  const [open, setOpen] = useState(false);

  // With one membership nothing is ever set active, and the gateway resolves the
  // only one there is. The key has to name it anyway, so the same fallback is
  // made here rather than leaving the button dead on a perfectly ordinary setup.
  const only =
    workspaces.data?.length === 1 ? workspaces.data[0]?.id : undefined;
  const workspaceId = active.data?.id ?? only;

  const openNew = useCallback(() => setOpen(true), []);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading font-medium text-base">API keys</h1>
          <p className="text-muted-foreground text-sm">
            A key lets a script or an agent reach this board's HTTP API as you.
            Send it as the <code className="font-mono">x-api-key</code> header;
            the operations it can call are the ones in{" "}
            <code className="font-mono">/openapi.json</code>.
          </p>
        </div>
        <Button onClick={openNew} size="sm">
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
          New key
        </Button>
      </header>

      {keys.isPending ? <Pending label="Loading keys" lines={3} /> : null}

      {keys.isError ? (
        <Failed
          error={keys.error}
          onRetry={keys.refetch}
          title="Keys did not load"
        />
      ) : null}

      {keys.data?.length === 0 ? (
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Key01Icon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>No keys yet</EmptyTitle>
            <EmptyDescription>
              You will need one to point your own agent at this board, or to
              call it from a script.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={openNew} size="sm" variant="outline">
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
              New key
            </Button>
          </EmptyContent>
        </Empty>
      ) : null}

      {keys.data === undefined || keys.data.length === 0 ? null : (
        <ItemGroup className="gap-2">
          {keys.data.map((apiKey) => (
            <KeyRow apiKey={apiKey} key={apiKey.id} />
          ))}
        </ItemGroup>
      )}

      <KeyFormDialog
        onOpenChange={setOpen}
        open={open}
        workspaceId={workspaceId}
      />
    </div>
  );
};
