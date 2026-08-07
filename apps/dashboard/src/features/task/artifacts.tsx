import { Download04Icon, File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { Artifact } from "@workspace/api";
import type { ArtifactId, TaskId } from "@workspace/domain";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@workspace/ui/components/item";
import { type ChangeEvent, useCallback, useMemo, useState } from "react";
import {
  artifactContentUrl,
  artifactsQuery,
  useUploadArtifact,
} from "@/api/artifacts";
import { EmptyState } from "@/components/empty-state";
import { Pending } from "@/components/query-state";
import { FileViewer } from "@/features/task/file-viewer";
import { failureText } from "@/lib/failure";
import { formatBytes, formatRelative } from "@/lib/format";

/**
 * The files a run kept, newest write first.
 *
 * A list and nothing more: names, sizes, when they changed. Everything anybody
 * does to a file — reading it, editing it, promoting it out of the task —
 * happens after they have opened one, which is the shape every file browser
 * already has and the reason a row carries no panel of its own.
 *
 * Which file is open is local state rather than an address: a file is a thing
 * inside a task, not a place, and the task's own URL already says where the
 * reader is.
 */
export const TaskArtifacts = ({ taskId }: { readonly taskId: TaskId }) => {
  const artifacts = useQuery(artifactsQuery(taskId));
  const [openId, setOpenId] = useState<ArtifactId | null>(null);

  // Read out of the list rather than held as a copy, so a row that changes
  // under an open viewer — a promotion, a save — is the row the viewer shows.
  const open = useMemo(
    () => artifacts.data?.find((file) => file.id === openId) ?? null,
    [artifacts.data, openId]
  );

  const close = useCallback((next: boolean) => {
    if (!next) {
      setOpenId(null);
    }
  }, []);

  return (
    <section className="flex flex-col gap-5">
      {artifacts.isPending ? <Pending label="Loading files" lines={3} /> : null}
      {artifacts.data?.length === 0 ? (
        <EmptyState
          description="Anything a run writes to its own folder shows up here."
          icon={File01Icon}
          title="No files yet"
        />
      ) : null}
      {artifacts.data === undefined || artifacts.data.length === 0 ? null : (
        <ItemGroup className="gap-0.5">
          {artifacts.data.map((artifact) => (
            <ArtifactRow
              artifact={artifact}
              key={artifact.id}
              onOpen={setOpenId}
              taskId={taskId}
            />
          ))}
        </ItemGroup>
      )}
      <Uploader taskId={taskId} />
      <FileViewer artifact={open} onOpenChange={close} taskId={taskId} />
    </section>
  );
};

interface RowProps {
  readonly artifact: Artifact;
  readonly onOpen: (artifactId: ArtifactId) => void;
  readonly taskId: TaskId;
}

/**
 * One file on one line.
 *
 * The row is the button that opens it, so the whole line is the target rather
 * than a word in it. Download stays here as a mark at the end: it is the one
 * thing somebody wants without looking inside first, and it is a link rather
 * than a button so the browser's own "save as" and middle-click still work.
 *
 * The badge says only "promoted", never where to: a promotion stamps this row
 * and writes the destination onto the copy, and the copy belongs to a folder
 * this list does not read. Naming a destination here could only be a guess.
 */
const ArtifactRow = ({ artifact, onOpen, taskId }: RowProps) => {
  const open = useCallback(() => onOpen(artifact.id), [artifact.id, onOpen]);

  return (
    <Item
      className="hover:bg-muted/50"
      onClick={open}
      render={<button type="button" />}
      size="xs"
    >
      <ItemMedia variant="icon">
        <HugeiconsIcon icon={File01Icon} strokeWidth={2} />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full min-w-0">
          <span className="truncate font-mono" title={artifact.path}>
            {artifact.path}
          </span>
        </ItemTitle>
      </ItemContent>
      <ItemActions className="shrink-0 gap-2 text-muted-foreground text-xs">
        {artifact.promotedAt === null ? null : (
          <Badge variant="outline">promoted</Badge>
        )}
        <span className="tabular-nums">{formatBytes(artifact.bytes)}</span>
        <span className="max-sm:hidden">
          {formatRelative(artifact.modifiedAt)}
        </span>
        <Button
          aria-label={`Download ${artifact.path}`}
          nativeButton={false}
          // The row is a button and this sits inside it, so the click has to
          // stop here or downloading would also open the viewer behind it.
          onClick={stopPropagation}
          render={<a download href={artifactContentUrl(taskId, artifact.id)} />}
          size="icon-xs"
          variant="ghost"
        >
          <HugeiconsIcon icon={Download04Icon} strokeWidth={2} />
        </Button>
      </ItemActions>
    </Item>
  );
};

const stopPropagation = (event: { stopPropagation: () => void }) =>
  event.stopPropagation();

/**
 * Putting a file into the task's folder by hand. The path is the natural key,
 * so uploading to one that already exists replaces that file rather than
 * making a second row; leaving it blank uses the file's own name.
 */
const Uploader = ({ taskId }: { readonly taskId: TaskId }) => {
  const [file, setFile] = useState<File | null>(null);
  const [path, setPath] = useState("");
  const upload = useUploadArtifact();
  const { mutate } = upload;

  const onFile = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setFile(event.target.files?.[0] ?? null);
  }, []);

  const onPath = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setPath(event.target.value);
  }, []);

  const send = useCallback(() => {
    if (file === null) {
      return;
    }
    mutate({
      file,
      path: path.trim() === "" ? file.name : path.trim(),
      taskId,
    });
  }, [file, mutate, path, taskId]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed p-3">
      <span className="font-medium text-muted-foreground text-xs">
        Add a file
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-64" onChange={onFile} type="file" />
        <Input
          className="max-w-48"
          onChange={onPath}
          placeholder="path in the folder"
          value={path}
        />
        <Button
          disabled={file === null || upload.isPending}
          onClick={send}
          size="sm"
        >
          Upload
        </Button>
      </div>
      {failureText(upload.error) === null ? null : (
        <p className="text-destructive text-xs">{failureText(upload.error)}</p>
      )}
    </div>
  );
};
