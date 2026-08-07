import {
  Cancel01Icon,
  CheckIcon,
  Download04Icon,
  FolderUploadIcon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { Artifact } from "@workspace/api";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@workspace/ui/components/drawer";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useIsMobile } from "@workspace/ui/hooks/use-mobile";
import { useCallback, useState } from "react";
import { artifactContentUrl, useUploadArtifact } from "@/api/artifacts";
import { taskQuery } from "@/api/tasks";
import {
  FileBody,
  FileSource,
  isEditable,
  type Renderer,
  rendererFor,
  useArtifactText,
} from "@/features/task/artifact-preview";
import { PromoteDialog } from "@/features/task/promote";
import { failureText } from "@/lib/failure";
import { formatBytes, formatRelative } from "@/lib/format";

interface NoticeInput {
  readonly editable: boolean;
  readonly editing: boolean;
  readonly live: boolean;
  readonly renderer: Renderer;
}

/**
 * The line under the header, or nothing.
 *
 * Two things are worth saying and never at the same moment: that a run holds
 * the folder, which is why the pencil is out, and that JSON is shown
 * pretty-printed but edited as stored, which only matters once somebody is
 * editing it.
 */
const editingNotice = ({ editable, editing, live, renderer }: NoticeInput) => {
  if (editing) {
    return renderer === "json"
      ? "Shown pretty-printed, edited as stored."
      : null;
  }
  return live && editable
    ? "A run has this folder open. Editing waits until it ends."
    : null;
};

interface FileViewerProps {
  /** The file being looked at, or null for no viewer at all. */
  readonly artifact: Artifact | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly taskId: TaskId;
}

/**
 * One file, opened over the list.
 *
 * The list is a list — names, sizes, when they changed — and everything a
 * person does to a file happens after they have opened it, which is the shape
 * a file browser already has. Opening in place would nest a framed preview
 * inside a framed panel inside a sheet, three surfaces deep, and the box a file
 * is edited in has no room left by then.
 *
 * A centred dialog on a desktop and a drawer up from the bottom on a phone:
 * the same body either way, in whichever container that screen already uses for
 * "look at this one thing without leaving the page".
 */
export const FileViewer = ({
  artifact,
  onOpenChange,
  taskId,
}: FileViewerProps) => {
  const isMobile = useIsMobile();
  const open = artifact !== null;

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const body =
    artifact === null ? null : (
      <FileViewerBody
        artifact={artifact}
        key={artifact.id}
        onClose={close}
        taskId={taskId}
      />
    );

  if (isMobile) {
    return (
      <Drawer onOpenChange={onOpenChange} open={open}>
        {/* Its height is a custom property rather than a class: the popup
            reads one to size itself, and a plain height would be overridden. */}
        <DrawerContent
          className="[--drawer-height:95dvh]"
          overlayProps={{
            className:
              "z-60 bg-black/40 supports-backdrop-filter:backdrop-blur-md",
            // Same as the dialog: opened from inside the task sheet, and the
            // primitive leaves a nested backdrop out unless told otherwise.
            forceRender: true,
          }}
          // Both are lifted over the task sheet, and the drawer rides above its
          // own backdrop on document order, the way the pair does at its
          // default depth. The popup cannot carry this: it sits inside the
          // viewport's stacking context, so a class there was measured against
          // its siblings and left the backdrop over the file.
          viewportProps={{ className: "z-60" }}
        >
          <DrawerTitle className="sr-only">
            {artifact?.path ?? "File"}
          </DrawerTitle>
          <DrawerDescription className="sr-only">
            The contents of this file, and what can be done with it.
          </DrawerDescription>
          {body}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="fixed z-60 flex h-[90dvh] max-h-[90dvh] w-full max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        overlayProps={{
          className:
            "z-60 bg-black/40 supports-backdrop-filter:backdrop-blur-md",
          // A file is opened from inside the task sheet, and the primitive
          // leaves a nested dialog's backdrop out by default. Without it there
          // is nothing over the sheet to dim, to blur, or to press to leave —
          // which is why this panel had no way out but the keyboard.
          forceRender: true,
        }}
        // The header carries its own close, at the end of its row of controls.
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">
          {artifact?.path ?? "File"}
        </DialogTitle>
        <DialogDescription className="sr-only">
          The contents of this file, and what can be done with it.
        </DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );
};

/**
 * The file, its facts, and its verbs.
 *
 * Every control sits in the top-right corner, in reading and in editing alike:
 * the pencil is replaced by the tick and the cross that end the edit, so the
 * one place a person looks for what they can do here does not move when they
 * start doing it. A row of buttons under the file would read as part of the
 * file, and would be somewhere else than the button that opened it.
 *
 * The draft lives here rather than beside the box it is typed into, because
 * saving is a header control and cannot reach into the body for the text.
 *
 * Editing is out while a run holds the folder: it is mounted into that run
 * writable, so a save would race whatever is working in there.
 */
const FileViewerBody = ({
  artifact,
  onClose,
  taskId,
}: {
  readonly artifact: Artifact;
  readonly onClose: () => void;
  readonly taskId: TaskId;
}) => {
  const renderer = rendererFor(artifact.ext);
  const editable = isEditable(renderer);

  const [draft, setDraft] = useState<string | null>(null);
  const detail = useQuery(taskQuery(taskId));
  const text = useArtifactText(taskId, artifact, editable);
  const upload = useUploadArtifact();
  const { mutate, reset } = upload;
  const live = (detail.data?.liveRunId ?? null) !== null;
  const source = text.data ?? "";

  const edit = useCallback(() => setDraft(source), [source]);

  const cancel = useCallback(() => {
    setDraft(null);
    reset();
  }, [reset]);

  const save = useCallback(() => {
    if (draft === null) {
      return;
    }
    mutate(
      { file: new File([draft], artifact.path), path: artifact.path, taskId },
      { onSuccess: () => setDraft(null) }
    );
  }, [artifact.path, draft, mutate, taskId]);

  const editing = draft !== null;
  const failed = failureText(upload.error);

  /** The one thing worth saying about this file's state, if there is one. */
  const notice = editingNotice({ editable, editing, live, renderer });

  return (
    <>
      <header className="flex shrink-0 items-start gap-3 border-border border-b p-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p
            className="truncate font-medium font-mono text-sm"
            title={artifact.path}
          >
            {artifact.path}
          </p>
          <p className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
            <span>{formatBytes(artifact.bytes)}</span>
            <span>{formatRelative(artifact.modifiedAt)}</span>
            {artifact.promotedAt === null ? null : (
              <Badge variant="outline">promoted</Badge>
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {editing ? (
            <>
              <SaveConfirm
                disabled={draft === source || upload.isPending}
                onConfirm={save}
                path={artifact.path}
              />
              <Button
                aria-label="Cancel"
                onClick={cancel}
                size="icon-sm"
                title="Cancel"
                variant="ghost"
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            </>
          ) : (
            <>
              {editable ? (
                <Button
                  aria-label="Edit"
                  disabled={live || text.data === undefined}
                  onClick={edit}
                  size="icon-sm"
                  title="Edit"
                  variant="ghost"
                >
                  <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
                </Button>
              ) : null}
              {artifact.promotedAt === null ? (
                // The trigger is handed a plain button element rather than a
                // component of ours: the primitive clones it to attach its own
                // props, which a wrapper that did not forward them would
                // swallow.
                <PromoteDialog
                  artifact={artifact}
                  render={
                    <Button
                      aria-label="Promote"
                      size="icon-sm"
                      title="Promote"
                      variant="ghost"
                    />
                  }
                  taskId={taskId}
                >
                  <HugeiconsIcon icon={FolderUploadIcon} strokeWidth={2} />
                </PromoteDialog>
              ) : null}
              <Button
                aria-label="Download"
                nativeButton={false}
                render={
                  <a download href={artifactContentUrl(taskId, artifact.id)} />
                }
                size="icon-sm"
                title="Download"
                variant="ghost"
              >
                <HugeiconsIcon icon={Download04Icon} strokeWidth={2} />
              </Button>

              {/* The way out, last in the row and separated from the verbs: it
                  does nothing to the file. Pressing outside the panel and
                  Escape close it too, but neither is visible, and a panel with
                  no close reads as one that cannot be closed. */}
              <Button
                aria-label="Close"
                className="ml-1"
                onClick={onClose}
                size="icon-sm"
                title="Close"
                variant="ghost"
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            </>
          )}
        </div>
      </header>

      {notice === null ? null : (
        <p className="shrink-0 border-border border-b px-3 py-1.5 text-muted-foreground text-xs">
          {notice}
        </p>
      )}
      {failed === null ? null : (
        <p className="shrink-0 border-border border-b px-3 py-1.5 text-destructive text-xs">
          {failed}
        </p>
      )}

      <Content
        artifact={artifact}
        draft={draft}
        error={text.error}
        loading={editable && text.isPending}
        onDraft={setDraft}
        renderer={renderer}
        source={source}
        taskId={taskId}
      />
    </>
  );
};

/**
 * Saving, and the two facts that earn a confirmation: nothing is versioned, and
 * the write reindexes the folder, clearing every row's record of which run
 * produced it.
 */
const SaveConfirm = ({
  disabled,
  onConfirm,
  path,
}: {
  readonly disabled: boolean;
  readonly onConfirm: () => void;
  readonly path: string;
}) => (
  <AlertDialog>
    <AlertDialogTrigger
      disabled={disabled}
      render={
        <Button aria-label="Save" size="icon-sm" title="Save" variant="ghost" />
      }
    >
      <HugeiconsIcon icon={CheckIcon} strokeWidth={2} />
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Replace {path}?</AlertDialogTitle>
        <AlertDialogDescription>
          The file is written over and nothing keeps the old bytes, so this
          cannot be undone. Writing also reindexes the folder, which clears
          which run produced each file in it.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={onConfirm}>Replace</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

interface ContentProps {
  readonly artifact: Artifact;
  readonly draft: string | null;
  readonly error: Error | null;
  readonly loading: boolean;
  readonly onDraft: (next: string) => void;
  readonly renderer: Renderer;
  readonly source: string;
  readonly taskId: TaskId;
}

/**
 * What is in the file.
 *
 * An image is left to the browser, which streams it straight off the content
 * endpoint. A file with no renderer is not read at all: there is nothing this
 * app could truthfully draw, so it says so and leaves the download as the way
 * to see it.
 */
const Content = ({
  artifact,
  draft,
  error,
  loading,
  onDraft,
  renderer,
  source,
  taskId,
}: ContentProps) => {
  if (renderer === "image") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {/* biome-ignore lint/performance/noImgElement: this is a Vite app, with no framework image component behind the rule. */}
        {/* biome-ignore lint/correctness/useImageSize: an artifact's dimensions are not in the index, and a guessed pair would distort it. */}
        <img
          alt={artifact.path}
          className="max-h-full max-w-full object-contain"
          src={artifactContentUrl(taskId, artifact.id)}
        />
      </div>
    );
  }

  if (renderer === "download") {
    return (
      <p className="p-6 text-center text-muted-foreground text-xs">
        Nothing here can read a {artifact.ext ?? "file"} of this kind. Download
        it to open it.
      </p>
    );
  }

  if (loading) {
    return <Skeleton className="m-3 h-40" />;
  }

  if (error !== null) {
    return <p className="p-6 text-destructive text-xs">{error.message}</p>;
  }

  if (draft !== null) {
    return (
      <div className="min-h-0 flex-1">
        <FileSource onChange={onDraft} value={draft} />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <FileBody ext={artifact.ext} renderer={renderer} source={source} />
    </div>
  );
};
