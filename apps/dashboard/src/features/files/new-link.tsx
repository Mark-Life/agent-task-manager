import { Link01Icon } from "@hugeicons/core-free-icons";
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
import { useCreateScopeLink } from "@/api/files";
import { failureSentence } from "@/components/query-state";
import { ScopeTree } from "@/features/files/tree";
import {
  joinScopePath,
  linkTextOf,
  scopePathOf,
  scopePathProblem,
} from "@/lib/scope-path";

interface NewLinkProps {
  /** The folder the link lands in, and null for the scope's own root. */
  readonly directory: ScopePath | null;
  /** Called with the link that was made, so the browser opens it. */
  readonly onCreated: (path: ScopePath) => void;
  readonly scope: FileScope;
}

/**
 * A second name for something that is already in this scope.
 *
 * **The target is picked, not typed.** A link is the one thing here whose two
 * ends have to agree with each other: a typo in a path creates a file, and a
 * typo in a link's target creates something that looks right in every listing
 * and reaches nothing. So the target comes out of the same tree the browser
 * draws, which means it exists by construction — and the text that will land on
 * disk is shown before anything is written, computed between the two the way the
 * server computes it.
 *
 * What it is mostly for: `AGENTS.md` holding a rule and `CLAUDE.md` pointing at
 * it, since neither agent CLI reads the other's name. The other use is a skill,
 * whose real files sit under `.agents/skills` and are reached through a link at
 * the path the other CLI scans.
 */
export const NewLink = ({ directory, onCreated, scope }: NewLinkProps) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState<ScopePath | null>(null);
  const [seeded, setSeeded] = useState<string | null>(null);

  // The dialog outlives one opening, so both halves are seeded from where the
  // reader is now rather than from where they were the last time.
  const token = open ? (directory ?? "") : null;
  if (seeded !== token) {
    setSeeded(token);
    setDraft(directory === null ? "" : `${directory}/`);
    setTarget(null);
  }

  const create = useCreateScopeLink();
  const { mutate } = create;

  const type = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    []
  );
  const close = useCallback(() => setOpen(false), []);

  const trimmed = draft.trim();
  const path = scopePathOf(trimmed);
  const problem = scopePathProblem(trimmed);

  const submit = useCallback(() => {
    if (path === null || target === null) {
      return;
    }
    mutate(
      { path, scope, target },
      {
        onSuccess: () => {
          setOpen(false);
          onCreated(path);
        },
      }
    );
  }, [mutate, onCreated, path, scope, target]);

  const failed = failureSentence(create.error);
  const text =
    path === null || target === null
      ? null
      : linkTextOf({ from: path, to: target });

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={<Button size="sm" variant="outline" />}
        title="New link"
      >
        <HugeiconsIcon icon={Link01Icon} strokeWidth={2} />
        <span className="max-sm:sr-only">New link</span>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New link</DialogTitle>
          <DialogDescription>
            One file under a second name. Editing either edits the same bytes,
            and deleting the link leaves what it points at alone.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-link-path">Path of the link</Label>
          <Input
            className="font-mono text-xs"
            id="new-link-path"
            onChange={type}
            placeholder={joinScopePath(directory, "CLAUDE.md")}
            value={draft}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Points at</Label>
          <div className="max-h-56 overflow-y-auto rounded-md border p-1">
            <ScopeTree onSelect={setTarget} scope={scope} selected={target} />
          </div>
          <p className="text-muted-foreground text-xs">
            {target === null
              ? "Pick the file or folder in this scope it should point at."
              : `On disk the link holds “${text}”, worked out from its own folder — never a path off this machine, which would resolve here and reach nothing inside a run.`}
          </p>
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
            disabled={create.isPending || path === null || target === null}
            onClick={submit}
          >
            Create link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
