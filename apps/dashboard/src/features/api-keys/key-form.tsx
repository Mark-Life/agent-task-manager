import { API_SCOPES, type ApiScope } from "@workspace/api";
import { Button } from "@workspace/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { NativeSelect } from "@workspace/ui/components/native-select";
import { type ChangeEvent, useCallback, useState } from "react";
import { useCreateApiKey } from "@/api/api-keys";
import { failureSentence } from "@/components/query-state";
import { KeyOnce } from "@/features/api-keys/key-once";

/**
 * What each scope actually lets a key do, in the terms of this board rather
 * than the terms of the contract. Somebody choosing here is deciding how much
 * of their own account to hand to a script, and "task-write" on its own does
 * not tell them that.
 */
const SCOPE_LABELS: Record<ApiScope, string> = {
  admin: "Everything — including deleting projects and reading stored secrets",
  read: "Read only — the board, tasks, runs and files, and no writes",
  "task-write": "Read and ordinary work — file, edit, move and delete tasks",
};

/**
 * How long a key may live. There is no right answer, so the list is short and
 * the default is the shortest thing that survives a piece of real work: a key
 * that expires over a weekend is a key somebody stops using the dashboard to
 * make.
 */
const LIFETIMES = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "A year" },
  { days: null, label: "Never expires" },
] as const;

const DEFAULT_LIFETIME_DAYS = 90;

/** The default scope: what the driving case needs, and not a step past it. */
const DEFAULT_SCOPE: ApiScope = "task-write";

interface KeyFormDialogProps {
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  /** The workspace the key will speak for. Absent while the session has none. */
  readonly workspaceId: string | undefined;
}

/**
 * Issuing a key, and showing it once.
 *
 * The dialog does not close on success. The value it just received is the only
 * copy that will ever exist — the library stores a hash — so the reader has to
 * be given the chance to take it, and closing the dialog for them is how a
 * person ends up issuing three keys before they get one.
 */
export const KeyFormDialog = ({
  onOpenChange,
  open,
  workspaceId,
}: KeyFormDialogProps) => {
  const create = useCreateApiKey();
  const { mutate, reset } = create;
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiScope>(DEFAULT_SCOPE);
  const [days, setDays] = useState<number | null>(DEFAULT_LIFETIME_DAYS);

  // Closing is what clears the issued key from the screen and from memory, so
  // reopening the dialog can never show somebody a secret they already stored.
  const close = useCallback(
    (next: boolean) => {
      if (!next) {
        setName("");
        setScope(DEFAULT_SCOPE);
        setDays(DEFAULT_LIFETIME_DAYS);
        reset();
      }
      onOpenChange(next);
    },
    [onOpenChange, reset]
  );

  const onName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );

  const onScope = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      setScope(event.target.value as ApiScope),
    []
  );

  const onLifetime = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const { value } = event.target;
    setDays(value === "never" ? null : Number(value));
  }, []);

  const dismiss = useCallback(() => close(false), [close]);

  const submit = useCallback(() => {
    if (workspaceId !== undefined) {
      mutate({ expiresInDays: days, name: name.trim(), scope, workspaceId });
    }
  }, [days, mutate, name, scope, workspaceId]);

  const issued = create.data ?? null;
  const ready = name.trim() !== "" && workspaceId !== undefined;

  return (
    <Dialog onOpenChange={close} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {issued === null ? "New API key" : "Your new key"}
          </DialogTitle>
          <DialogDescription>
            {issued === null
              ? "A key acts as you, with the permissions you choose here and no more. Anything it changes is recorded under your name."
              : "This is the only time it is shown. Copy it now — what is stored is a hash, so it cannot be shown again."}
          </DialogDescription>
        </DialogHeader>

        {issued === null ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="key-name">Name</Label>
              <Input
                autoFocus
                id="key-name"
                onChange={onName}
                placeholder="Laptop agent"
                value={name}
              />
              <p className="text-muted-foreground text-xs">
                What this key is for. It is how you will recognise it in the
                list when you come to revoke it.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="key-scope">What it may do</Label>
              <NativeSelect id="key-scope" onChange={onScope} value={scope}>
                {API_SCOPES.map((value) => (
                  <option key={value} value={value}>
                    {SCOPE_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="key-expiry">Expires</Label>
              <NativeSelect
                id="key-expiry"
                onChange={onLifetime}
                value={days === null ? "never" : String(days)}
              >
                {LIFETIMES.map((lifetime) => (
                  <option
                    key={lifetime.label}
                    value={lifetime.days === null ? "never" : lifetime.days}
                  >
                    {lifetime.label}
                  </option>
                ))}
              </NativeSelect>
            </div>

            {workspaceId === undefined ? (
              <p className="text-destructive text-xs">
                Choose a workspace in the sidebar first — a key speaks for one
                board and has to be told which.
              </p>
            ) : null}

            {create.isError ? (
              <p className="text-destructive text-xs">
                {failureSentence(create.error)}
              </p>
            ) : null}
          </div>
        ) : (
          <KeyOnce value={issued} />
        )}

        <DialogFooter>
          {issued === null ? (
            <>
              <Button onClick={dismiss} variant="outline">
                Cancel
              </Button>
              <Button disabled={!ready || create.isPending} onClick={submit}>
                Create key
              </Button>
            </>
          ) : (
            <Button onClick={dismiss}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
