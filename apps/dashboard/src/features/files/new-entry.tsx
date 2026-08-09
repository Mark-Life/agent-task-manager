import { FileAddIcon, FolderAddIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { FileScope, ScopePath } from "@workspace/domain";
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
import { useCreateScopeDirectory, useWriteScopeFile } from "@/api/files";
import { failureSentence } from "@/components/query-state";
import { joinScopePath, scopePathOf, scopePathProblem } from "@/lib/scope-path";

/** What each kind is called on its button, in its dialog, and in the box. */
const FACES = {
  directory: {
    description:
      "Directories above it are created with it, so a whole layout can be typed in one go.",
    icon: FolderAddIcon,
    label: "New folder",
    placeholder: "notes",
  },
  file: {
    description:
      "The file is created empty and opens for editing. Directories above it are created with it.",
    icon: FileAddIcon,
    label: "New file",
    placeholder: "AGENTS.md",
  },
} as const;

interface NewEntryProps {
  /** The folder it lands in, and null for the scope's own root. */
  readonly directory: ScopePath | null;
  readonly kind: keyof typeof FACES;
  /** Called with what was created, so the browser opens it rather than leaving the reader to find it. */
  readonly onCreated: (path: ScopePath) => void;
  readonly scope: FileScope;
}

/**
 * Adding something to a scope, at the folder the reader is standing in.
 *
 * The path in the box is the whole scope-relative one, prefilled with wherever
 * the selection is: a person who has opened `.agents/skills` and pressed "new
 * folder" is typing a skill's name, and a person at the root is typing a path.
 * One control does both because the difference is only which prefix was already
 * there.
 *
 * A new file is a write of nothing, which is what makes it one request rather
 * than a create and a save — and it means the editor opens on a file that is
 * really on disk, not on a draft that would be lost by a stray click.
 */
export const NewEntry = ({
  directory,
  kind,
  onCreated,
  scope,
}: NewEntryProps) => {
  const face = FACES[kind];
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [seeded, setSeeded] = useState<string | null>(null);

  // The dialog outlives one opening, so what is in the box is seeded from where
  // the reader is now rather than from where they were the last time.
  const token = open ? (directory ?? "") : null;
  if (seeded !== token) {
    setSeeded(token);
    setDraft(directory === null ? "" : `${directory}/`);
  }

  const write = useWriteScopeFile();
  const makeDirectory = useCreateScopeDirectory();
  const pending = write.isPending || makeDirectory.isPending;

  const type = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    []
  );
  const close = useCallback(() => setOpen(false), []);

  const trimmed = draft.trim();
  const path = scopePathOf(trimmed);
  const problem = scopePathProblem(trimmed);

  const submit = useCallback(() => {
    if (path === null) {
      return;
    }
    const done = {
      onSuccess: () => {
        setOpen(false);
        onCreated(path);
      },
    };
    if (kind === "directory") {
      makeDirectory.mutate({ path, scope }, done);
      return;
    }
    write.mutate({ content: "", path, scope }, done);
  }, [kind, makeDirectory, onCreated, path, scope, write]);

  const failed = failureSentence(write.error ?? makeDirectory.error);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={<Button size="sm" variant="outline" />}
        title={face.label}
      >
        <HugeiconsIcon icon={face.icon} strokeWidth={2} />
        <span className="max-sm:sr-only">{face.label}</span>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{face.label}</DialogTitle>
          <DialogDescription>{face.description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`new-${kind}-path`}>Path</Label>
          <Input
            className="font-mono text-xs"
            id={`new-${kind}-path`}
            onChange={type}
            placeholder={joinScopePath(directory, face.placeholder)}
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
          <Button disabled={pending || path === null} onClick={submit}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
