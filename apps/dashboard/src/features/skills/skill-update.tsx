import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { SkillFileChange } from "@workspace/api";
import type { FileScope, SkillName } from "@workspace/domain";
import { Badge } from "@workspace/ui/components/badge";
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
import { CodeBlock } from "@workspace/ui/components/markdown";
import { useCallback, useState } from "react";
import { skillUpdateQuery, useApplySkillUpdate } from "@/api/skills";
import { Failed, failureSentence, Pending } from "@/components/query-state";
import { formatBytes } from "@/lib/format";

/** How each outcome reads, and how loud it is drawn. */
const STATUS_FACES = {
  added: { label: "new", variant: "default" },
  changed: { label: "changed", variant: "default" },
  removed: { label: "removed", variant: "destructive" },
  unchanged: { label: "unchanged", variant: "outline" },
} as const;

/** Everything but the files that are staying exactly as they are. */
const isMoved = (file: SkillFileChange) => file.status !== "unchanged";

/**
 * One file of the review: what happens to it, and the text that would land.
 *
 * Only the incoming side is drawn. What is installed is already readable in the
 * file browser under the skill's own directory, and reading it there is also how
 * a person sees an edit somebody made to an installed skill by hand — which is
 * exactly what applying this is about to prune.
 */
const FileChange = ({ file }: { readonly file: SkillFileChange }) => {
  const face = STATUS_FACES[file.status];

  return (
    <div className="min-w-0 overflow-hidden rounded-md border">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-1.5">
        <p className="min-w-0 truncate font-mono text-xs" title={file.path}>
          {file.path}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatBytes(file.bytes)}
          </span>
          <Badge variant={face.variant}>{face.label}</Badge>
        </div>
      </div>
      {file.content === null ? (
        <p className="p-3 text-muted-foreground text-xs">
          {file.status === "removed"
            ? "The source no longer has this file, so applying deletes it."
            : "These bytes are not text, or are too large to review here. Applying writes them as they are."}
        </p>
      ) : (
        <CodeBlock
          className="[&_pre]:max-h-64 [&_pre]:rounded-none [&_pre]:border-0"
          code={file.content}
          lang="markdown"
        />
      )}
    </div>
  );
};

interface ReviewProps {
  readonly name: SkillName;
  readonly onApplied: () => void;
  readonly scope: FileScope;
}

/**
 * What the source holds now, against what is installed.
 *
 * Fetched when this mounts, which is when somebody opened the dialog — the one
 * read in this app that leaves the machine for another server, so it does not
 * happen while a list is merely being drawn.
 */
const Review = ({ name, onApplied, scope }: ReviewProps) => {
  const update = useQuery(skillUpdateQuery({ name, scope }));
  const apply = useApplySkillUpdate();
  const { mutate } = apply;

  const latestHash = update.data?.latestHash;

  const submit = useCallback(() => {
    if (latestHash !== undefined) {
      mutate(
        { expectedHash: latestHash, name, scope },
        { onSuccess: onApplied }
      );
    }
  }, [latestHash, mutate, name, onApplied, scope]);

  if (update.isPending) {
    return <Pending label="Asking the source" lines={4} />;
  }

  if (update.isError) {
    return (
      <Failed
        error={update.error}
        onRetry={update.refetch}
        title="The source did not answer"
      />
    );
  }

  const moved = update.data.files.filter(isMoved);
  const failed = failureSentence(apply.error);

  return (
    <>
      <div className="flex max-h-96 min-w-0 flex-col gap-2 overflow-y-auto">
        {update.data.changed ? null : (
          <p className="text-muted-foreground text-xs">
            The source hashes to what is installed. Nothing would change.
          </p>
        )}
        {(update.data.changed ? moved : update.data.files).map((file) => (
          <FileChange file={file} key={file.path} />
        ))}
      </div>

      <p className="text-muted-foreground text-xs">
        Applying fetches the source again and is refused if it moved in the
        meantime, so what lands is what is on this screen. Files the source no
        longer has go with it — including anything edited here by hand.
      </p>

      {failed === null ? null : (
        <p className="text-destructive text-xs">{failed}</p>
      )}

      <DialogFooter>
        <Button
          disabled={apply.isPending || !update.data.changed}
          onClick={submit}
        >
          Apply
        </Button>
      </DialogFooter>
    </>
  );
};

interface UpdateProps {
  readonly name: SkillName;
  readonly scope: FileScope;
}

/**
 * Checking a skill against where it came from, and applying what was read.
 *
 * Two steps rather than one button that fetches and writes. An update nobody
 * read is what a lock file exists to prevent: these are instructions an agent
 * follows on this workspace's own repositories, and a repository somebody else
 * owns can change between one run and the next.
 */
export const SkillUpdateReview = ({ name, scope }: UpdateProps) => {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={<Button size="sm" variant="ghost" />}
        title={`Check ${name} against its source`}
      >
        <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
        Check for an update
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
          <DialogDescription>
            What the source holds now, against what is installed here.
          </DialogDescription>
        </DialogHeader>

        {open ? <Review name={name} onApplied={close} scope={scope} /> : null}
      </DialogContent>
    </Dialog>
  );
};
