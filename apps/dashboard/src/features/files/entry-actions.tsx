import { Delete02Icon, ExchangeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { FileEntry } from "@workspace/api";
import type { FileScope, ScopePath } from "@workspace/domain";
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
import { Button } from "@workspace/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { type ChangeEvent, useCallback, useState } from "react";
import { useDeleteScopeFile, useMoveScopeFile } from "@/api/files";
import { failureSentence } from "@/components/query-state";
import { scopeKeepsHistory } from "@/features/files/scopes";
import { parentOf, scopePathOf, scopePathProblem } from "@/lib/scope-path";

interface EntryActionProps {
  readonly entry: FileEntry;
  /** Where the selection goes once the entry this is about is no longer there. */
  readonly onMoved: (path: ScopePath | null) => void;
  readonly path: ScopePath;
  readonly scope: FileScope;
}

/**
 * Renaming, as the whole path rather than the last segment.
 *
 * Typing a path is what makes "move this into that folder" the same gesture as
 * "call this something else", which is most of what organising a directory is.
 * The destination must not exist — the server refuses to replace a file
 * silently, because that would be the one operation here with no confirmation
 * and bytes findable afterwards only by somebody who thought to read the git
 * log.
 */
export const RenameEntry = ({
  entry,
  onMoved,
  path,
  scope,
}: EntryActionProps) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string>(path);
  const [seeded, setSeeded] = useState<string | null>(null);

  // Seeded while rendering: the dialog stays mounted between openings, and what
  // is in the box has to be the path as it is now rather than the one somebody
  // typed and abandoned last time.
  const token = open ? path : null;
  if (seeded !== token) {
    setSeeded(token);
    setDraft(path);
  }

  const move = useMoveScopeFile();
  const { mutate } = move;

  const type = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    []
  );
  const close = useCallback(() => setOpen(false), []);

  const trimmed = draft.trim();
  const destination = scopePathOf(trimmed);
  const problem = scopePathProblem(trimmed);

  const submit = useCallback(() => {
    if (destination === null) {
      return;
    }
    mutate(
      { from: path, scope, to: destination },
      {
        onSuccess: () => {
          setOpen(false);
          onMoved(destination);
        },
      }
    );
  }, [destination, mutate, onMoved, path, scope]);

  const failed = failureSentence(move.error);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <Button
            aria-label="Rename"
            size="icon-sm"
            title="Rename"
            variant="ghost"
          />
        }
      >
        <HugeiconsIcon icon={ExchangeIcon} strokeWidth={2} />
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Rename {entry.name}</DialogTitle>
          <DialogDescription>
            The path is relative to this scope's own root, so a name with a “/”
            in it moves the {entry.kind === "directory" ? "folder" : "file"} as
            well as renaming it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rename-path">New path</Label>
          <Input
            className="font-mono text-xs"
            id="rename-path"
            onChange={type}
            value={draft}
          />
        </div>

        {problem === null ? null : (
          <p className="text-destructive text-xs">{problem}</p>
        )}
        {failed === null ? null : (
          <p className="text-destructive text-xs">{failed}</p>
        )}

        <DialogFooter>
          <Button onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={
              move.isPending || destination === null || destination === path
            }
            onClick={submit}
          >
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** What is lost, said in the words of the thing being removed. */
const removalSentence = (entry: FileEntry, keepsHistory: boolean) => {
  if (entry.kind === "symlink") {
    return "The link is removed. Whatever it points at is left exactly where it is.";
  }
  const what =
    entry.kind === "directory"
      ? "The folder and everything under it go."
      : "The file goes.";
  return keepsHistory
    ? `${what} This scope keeps a git history, so the bytes are still in it and a commit brings them back.`
    : `${what} This folder keeps no history, so nothing anywhere holds the old bytes.`;
};

/**
 * Removing an entry, with the one fact that decides whether it matters.
 *
 * The shared scopes are git repositories committed around every run and around
 * every edit made here, so a delete there is recoverable. A task's folder is
 * not, and saying which of the two a person is standing in is the difference
 * between an undo and a run's only output being gone.
 */
export const DeleteEntry = ({
  entry,
  onMoved,
  path,
  scope,
}: EntryActionProps) => {
  const remove = useDeleteScopeFile();
  const { mutate } = remove;

  const confirm = useCallback(() => {
    mutate({ path, scope }, { onSuccess: () => onMoved(parentOf(path)) });
  }, [mutate, onMoved, path, scope]);

  const failed = failureSentence(remove.error);

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            aria-label={`Delete ${entry.name}`}
            size="icon-sm"
            title="Delete"
            variant="ghost"
          />
        }
      >
        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{entry.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {removalSentence(entry, scopeKeepsHistory(scope))}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failed === null ? null : (
          <p className="text-destructive text-xs">{failed}</p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep</AlertDialogCancel>
          <AlertDialogAction
            disabled={remove.isPending}
            onClick={confirm}
            variant="destructive"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
