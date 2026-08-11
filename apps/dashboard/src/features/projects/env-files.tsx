import { Delete02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { ProjectEnvFile } from "@workspace/api";
import type {
  EnvFilePath,
  ProjectEnvFileId,
  ProjectId,
} from "@workspace/domain";
import { relativePathRefusalOf } from "@workspace/domain";
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
} from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Textarea } from "@workspace/ui/components/textarea";
import { type ChangeEvent, useCallback, useState } from "react";
import {
  projectEnvFileQuery,
  projectEnvFilesQuery,
  useDeleteProjectEnvFile,
  useSaveProjectEnvFile,
} from "@/api/project-env";
import { Failed, failureSentence, Pending } from "@/components/query-state";
import { useUpdateHold } from "@/pwa/hold";

/** What each refusal means to the person typing the path. */
const PATH_REFUSALS: Record<string, string> = {
  absolute: "Give a path inside the repository, not one starting with “/”.",
  backslash: "Use “/” between directories.",
  control_character: "That path has a character a filename cannot hold.",
  dot_segment: "No “.” or “..” — the path has to stay inside the checkout.",
  empty: "Give the file a path, like “.env” or “apps/web/.env”.",
  empty_segment: "Two slashes in a row, or a trailing one.",
  git_directory: "Nothing may be written into “.git”.",
  too_long: "That path is longer than the store accepts.",
};

/** The complaint about a path, or null when there is nothing to say. */
const pathProblem = (path: string) => {
  if (path === "") {
    return null;
  }
  const refusal = relativePathRefusalOf(path);
  return refusal === null
    ? null
    : (PATH_REFUSALS[refusal] ?? "Not a usable path.");
};

interface EditorProps {
  /** Absent adds a new file; present edits that one, with its path fixed. */
  readonly file?: ProjectEnvFile;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly projectId: ProjectId;
}

/**
 * Whether this dialog is holding something a reload would destroy.
 *
 * Compared against what was seeded rather than against emptiness: the boxes
 * arrive holding the file, so "has something in it" is true from the moment it
 * opens, and only a difference means somebody typed. What is typed here is an
 * environment file, which nothing else has a copy of until it is saved — which
 * is what makes it worth holding a background update off for.
 */
const hasEdits = (input: {
  readonly content: string;
  readonly open: boolean;
  readonly path: string;
  readonly seeded: { readonly content: string; readonly path: string };
}) => {
  if (!input.open) {
    return false;
  }
  return (
    input.path !== input.seeded.path || input.content !== input.seeded.content
  );
};

/**
 * One file's whole text, in a plain textarea.
 *
 * A textarea and not a key-value grid, and that is the decision the whole
 * feature rests on: a `.env` carries comments, blank lines, quoting and
 * multi-line values, and every one of those is destroyed the first time a
 * key-value editor saves. What the operator sees here is the file.
 *
 * The content is fetched only when this opens, under its own key, so a project
 * screen that is merely listing paths never holds a secret in memory.
 *
 * The textarea is sized by the dialog and not by what was pasted into it. The
 * shared control ships `field-sizing-content`, which grows a field to its widest
 * line — and one connection string is wider than any screen, so the box, the
 * save button and the cancel button all leave the viewport together. Fixed
 * sizing plus `break-all` keeps a long secret wrapped inside the dialog.
 *
 * The path is fixed once a file exists. It is the natural key, so changing it
 * would be filing a second file rather than renaming one, and doing that
 * silently would leave the old file still being written into every run.
 */
const EnvFileEditor = ({
  file,
  onOpenChange,
  open,
  projectId,
}: EditorProps) => {
  const existing = useQuery({
    ...projectEnvFileQuery({
      fileId: file?.id ?? ("" as ProjectEnvFileId),
      projectId,
    }),
    enabled: open && file !== undefined,
  });

  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [seeded, setSeeded] = useState<string | null>(null);

  // Seeded while rendering rather than in an effect, so a stale draft is never
  // visible for a frame: the dialog stays mounted between openings, and the
  // text it holds has to be the file as it is now.
  //
  // The token carries whether the text has arrived as well as which file it is,
  // because the fetch finishes after the dialog opens — a token that named only
  // the file would seed the empty box once and never replace it.
  const token = open
    ? `${file?.id ?? "new"}:${existing.data === undefined ? "pending" : "loaded"}`
    : null;
  if (seeded !== token) {
    setSeeded(token);
    setPath(file?.path ?? "");
    setContent(existing.data?.content ?? "");
  }

  useUpdateHold(
    hasEdits({
      content,
      open,
      path,
      seeded: {
        content: existing.data?.content ?? "",
        path: file?.path ?? "",
      },
    }),
    "an environment file is being edited"
  );

  const save = useSaveProjectEnvFile();
  const { mutate } = save;

  const onPath = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setPath(event.target.value),
    []
  );
  const onContent = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => setContent(event.target.value),
    []
  );
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const submit = useCallback(() => {
    mutate(
      { content, path: path.trim() as EnvFilePath, projectId },
      { onSuccess: close }
    );
  }, [close, content, mutate, path, projectId]);

  const problem = pathProblem(path.trim());
  const failed = failureSentence(save.error);
  const loading = file !== undefined && existing.isPending;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {file === undefined ? "New environment file" : file.path}
          </DialogTitle>
          <DialogDescription>
            Written into the checkout of every run in this project, and stored
            encrypted. The agent can read it — so anything in here can end up in
            a transcript.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {file === undefined ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="env-path">Path</Label>
              <Input
                id="env-path"
                onChange={onPath}
                placeholder=".env.local"
                value={path}
              />
              <p className="text-muted-foreground text-xs">
                Relative to the repository root. The path is the key, so saving
                over an existing one replaces it.
              </p>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="env-content">Contents</Label>
            <Textarea
              className="field-sizing-fixed w-full max-w-full break-all font-mono text-xs"
              disabled={loading}
              id="env-content"
              onChange={onContent}
              rows={16}
              value={loading ? "" : content}
            />
          </div>
        </div>

        {existing.isError ? (
          <p className="text-destructive text-xs">
            {failureSentence(existing.error) ?? "That file did not load."}
          </p>
        ) : null}
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
              loading ||
              save.isPending ||
              path.trim() === "" ||
              problem !== null
            }
            onClick={submit}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

interface RowProps {
  readonly file: ProjectEnvFile;
  readonly onEdit: (file: ProjectEnvFile) => void;
  readonly projectId: ProjectId;
}

/** One path, with the two things that can be done to it. */
const EnvFileRow = ({ file, onEdit, projectId }: RowProps) => {
  const remove = useDeleteProjectEnvFile();
  const { mutate } = remove;

  const edit = useCallback(() => onEdit(file), [file, onEdit]);
  const confirm = useCallback(
    () => mutate({ fileId: file.id, projectId }),
    [file.id, mutate, projectId]
  );

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
      <button
        className="truncate text-left font-mono text-xs hover:underline"
        onClick={edit}
        type="button"
      >
        {file.path}
      </button>
      <AlertDialog>
        <AlertDialogTrigger
          render={
            <Button
              aria-label={`Delete ${file.path}`}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{file.path}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Runs in this project stop being given it. Anything already written
              into a finished run's checkout is long gone. There is no undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
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
    </div>
  );
};

interface ProjectEnvFilesProps {
  readonly projectId: ProjectId;
}

/**
 * The environment files one project injects.
 *
 * A list of paths and a button, because that is genuinely all there is: the
 * value of a file is behind one more click, and nothing on this screen shows a
 * secret until somebody asks for one.
 */
export const ProjectEnvFiles = ({ projectId }: ProjectEnvFilesProps) => {
  const files = useQuery(projectEnvFilesQuery(projectId));
  const [editing, setEditing] = useState<ProjectEnvFile | undefined>(undefined);
  const [open, setOpen] = useState(false);

  const openNew = useCallback(() => {
    setEditing(undefined);
    setOpen(true);
  }, []);

  const openEdit = useCallback((file: ProjectEnvFile) => {
    setEditing(file);
    setOpen(true);
  }, []);

  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-4">
        <h2 className="font-medium text-sm">Environment files</h2>
        <Button onClick={openNew} size="sm" variant="outline">
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
          Add file
        </Button>
      </header>

      {files.isPending ? <Pending label="Loading files" lines={2} /> : null}

      {files.isError ? (
        <Failed
          error={files.error}
          onRetry={files.refetch}
          title="Environment files did not load"
        />
      ) : null}

      {files.data?.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          None. A run in this project gets whatever the repository ships and
          nothing else — no database URL, no API key, no dev server.
        </p>
      ) : null}

      {files.data?.map((file) => (
        <EnvFileRow
          file={file}
          key={file.id}
          onEdit={openEdit}
          projectId={projectId}
        />
      ))}

      <EnvFileEditor
        file={editing}
        onOpenChange={setOpen}
        open={open}
        projectId={projectId}
      />
    </section>
  );
};
