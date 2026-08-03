import { useQuery } from "@tanstack/react-query";
import type { Artifact } from "@workspace/api";
import { PROMOTION_SCOPES } from "@workspace/api";
import type { TaskId } from "@workspace/domain";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import { Input } from "@workspace/ui/components/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@workspace/ui/components/native-select";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { type ChangeEvent, useCallback, useState } from "react";
import {
  artifactContentUrl,
  artifactsQuery,
  usePromoteArtifact,
  useUploadArtifact,
} from "@/api/artifacts";
import { failureText } from "@/features/task/actions";
import { ArtifactPreview, rendererFor } from "@/features/task/artifact-preview";
import { formatRelative } from "@/lib/format";

/** How many bytes go in a kilobyte, for a size a person reads rather than counts. */
const KILO = 1024;

const formatBytes = (bytes: number) =>
  bytes < KILO ? `${bytes} B` : `${Math.round(bytes / KILO)} kB`;

/**
 * The files a run kept, newest write first, with the one verb that outlives the
 * task: promotion.
 *
 * Only the task's own folder is writable — the project's and the global folder
 * are read-only mounts to every run — so promoting is how material survives the
 * task that produced it, and the copy is deliberate rather than a side effect
 * of writing to a shared path.
 */
export const TaskArtifacts = ({ taskId }: { readonly taskId: TaskId }) => {
  const artifacts = useQuery(artifactsQuery(taskId));

  return (
    <section className="flex flex-col gap-6">
      <Uploader taskId={taskId} />
      {artifacts.isPending ? <Skeleton className="h-16 w-full" /> : null}
      {artifacts.data?.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No files yet</EmptyTitle>
            <EmptyDescription>
              Anything a run writes to its own folder shows up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      <ul className="flex flex-col gap-4">
        {artifacts.data?.map((artifact) => (
          <ArtifactRow artifact={artifact} key={artifact.id} taskId={taskId} />
        ))}
      </ul>
    </section>
  );
};

interface RowProps {
  readonly artifact: Artifact;
  readonly taskId: TaskId;
}

/**
 * One file: what it is, and the things that can be done with it.
 *
 * The badge says only "promoted", never where to: a promotion stamps this row
 * and writes the destination onto the copy, and the copy belongs to a folder
 * this list does not read. Naming a destination here could only be a guess.
 */
const ArtifactRow = ({ artifact, taskId }: RowProps) => {
  const renderer = rendererFor(artifact.ext);
  const href = artifactContentUrl(taskId, artifact.id);

  return (
    <li className="flex flex-col gap-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <span className="font-medium font-mono text-foreground">
          {artifact.path}
        </span>
        <span>{formatBytes(artifact.bytes)}</span>
        <span>{formatRelative(artifact.modifiedAt)}</span>
        {artifact.promotedAt === null ? null : (
          <Badge variant="outline">promoted</Badge>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          nativeButton={false}
          render={<a download href={href} />}
          size="xs"
          variant="outline"
        >
          Download
        </Button>
        {artifact.promotedAt === null ? (
          <PromoteDialog artifact={artifact} taskId={taskId} />
        ) : null}
        {renderer === "download" ? null : (
          <Collapsible>
            <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
              Preview
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <ArtifactPreview
                artifact={artifact}
                renderer={renderer}
                taskId={taskId}
              />
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </li>
  );
};

/**
 * Promotion, behind a confirmation and a choice of destination.
 *
 * It copies the bytes rather than pointing at them, so a later edit to this
 * file cannot retroactively change what another task worked from, and it can
 * only happen once — which is why the button disappears afterwards instead of
 * staying live and being refused.
 */
const PromoteDialog = ({ artifact, taskId }: RowProps) => {
  const [scope, setScope] =
    useState<(typeof PROMOTION_SCOPES)[number]>("project");
  const promote = usePromoteArtifact();
  const { mutate } = promote;

  const onScope = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    setScope(event.target.value === "global" ? "global" : "project");
  }, []);

  const confirm = useCallback(() => {
    mutate({ artifactId: artifact.id, scope, taskId });
  }, [artifact.id, mutate, scope, taskId]);

  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button size="xs" variant="ghost" />}>
        Promote
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Promote {artifact.path}?</AlertDialogTitle>
          <AlertDialogDescription>
            A copy is placed in the shared folder and keeps its own record of
            where it came from. Runs can read those folders and cannot write to
            them, so the copy stays as it is until somebody promotes over it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <NativeSelect className="w-full" onChange={onScope} value={scope}>
          {PROMOTION_SCOPES.map((candidate) => (
            <NativeSelectOption key={candidate} value={candidate}>
              {candidate === "project"
                ? "The project's folder"
                : "The global folder"}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {failureText(promote.error) === null ? null : (
          <p className="text-destructive text-xs">
            {failureText(promote.error)}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={promote.isPending} onClick={confirm}>
            Promote
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

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
    <div className="flex flex-wrap items-center gap-2">
      <Input className="max-w-64" onChange={onFile} type="file" />
      <Input
        className="max-w-48"
        onChange={onPath}
        placeholder="path in the folder"
        value={path}
      />
      <Button disabled={file === null || upload.isPending} onClick={send}>
        Upload
      </Button>
      {failureText(upload.error) === null ? null : (
        <p className="text-destructive text-xs">{failureText(upload.error)}</p>
      )}
    </div>
  );
};
