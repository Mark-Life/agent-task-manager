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
import { Button } from "@workspace/ui/components/button";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Textarea } from "@workspace/ui/components/textarea";
import { type ChangeEvent, useCallback, useState } from "react";
import { artifactContentUrl, useUploadArtifact } from "@/api/artifacts";
import { keys } from "@/api/keys";
import { taskQuery } from "@/api/tasks";
import { failureText } from "@/lib/failure";

/** Extensions worth showing inline as text, whatever they hold. */
const TEXT_EXTS = new Set([
  "csv",
  "css",
  "diff",
  "html",
  "js",
  "log",
  "md",
  "markdown",
  "patch",
  "py",
  "sh",
  "sql",
  "ts",
  "tsx",
  "txt",
  "yaml",
  "yml",
]);

/** Extensions the browser can draw without help. */
const IMAGE_EXTS = new Set([
  "avif",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

const INDENT = 2;

/**
 * Which renderer a file gets, from its extension alone.
 *
 * The index records the extension and the server deliberately guesses no
 * content type, so this is the only signal there is — and anything unrecognised
 * is offered as a download rather than drawn wrongly. Markdown is shown as its
 * source: nothing here renders it, and a half-rendered document is worse than
 * the text somebody wrote.
 */
export const rendererFor = (ext: string | null) => {
  const lower = ext?.toLowerCase() ?? "";
  if (lower === "json") {
    return "json" as const;
  }
  if (IMAGE_EXTS.has(lower)) {
    return "image" as const;
  }
  return TEXT_EXTS.has(lower) ? ("text" as const) : ("download" as const);
};

/** Pretty-printed when it parses, verbatim when it does not. */
const reindent = (source: string) => {
  try {
    return JSON.stringify(JSON.parse(source), null, INDENT);
  } catch {
    return source;
  }
};

interface PreviewProps {
  readonly artifact: Artifact;
  readonly renderer: "image" | "json" | "text";
  readonly taskId: TaskId;
}

interface TextProps extends Omit<PreviewProps, "renderer"> {
  readonly renderer: "json" | "text";
  /** The bytes as they are on disk, which is what an edit starts from. */
  readonly source: string;
}

/**
 * The text of a file, and the way to change it.
 *
 * There is no edit endpoint: an upload to a path that already exists replaces
 * that file, so saving is an upload of the same path, and the row keeps its id
 * and its promotion. Two consequences earn the confirmation — nothing is
 * versioned, and the write reindexes the folder, clearing every row's record of
 * which run produced it. The button is out while a run holds the folder, which
 * is mounted into it writable.
 */
const EditableText = ({ artifact, renderer, source, taskId }: TextProps) => {
  const [draft, setDraft] = useState<string | null>(null);
  const detail = useQuery(taskQuery(taskId));
  const upload = useUploadArtifact();
  const { mutate, reset } = upload;
  const live = (detail.data?.liveRunId ?? null) !== null;

  const open = useCallback(() => setDraft(source), [source]);

  const cancel = useCallback(() => {
    setDraft(null);
    reset();
  }, [reset]);

  const onDraft = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value);
  }, []);

  const save = useCallback(() => {
    if (draft === null) {
      return;
    }
    mutate(
      { file: new File([draft], artifact.path), path: artifact.path, taskId },
      { onSuccess: () => setDraft(null) }
    );
  }, [artifact.path, draft, mutate, taskId]);

  if (draft === null) {
    return (
      <div className="flex flex-col gap-2">
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 font-mono text-xs">
          {renderer === "json" ? reindent(source) : source}
        </pre>
        <Button disabled={live} onClick={open} size="xs" variant="outline">
          Edit
        </Button>
        {live ? (
          <p className="text-muted-foreground text-xs">
            A run has this folder open. Editing waits until it ends.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        className="max-h-96 overflow-auto font-mono"
        onChange={onDraft}
        rows={16}
        value={draft}
      />
      {renderer === "json" ? (
        <p className="text-muted-foreground text-xs">
          Shown pretty-printed, edited as stored.
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <AlertDialog>
          <AlertDialogTrigger
            disabled={draft === source || upload.isPending}
            render={<Button size="xs" />}
          >
            Save
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Replace {artifact.path}?</AlertDialogTitle>
              <AlertDialogDescription>
                The file is written over and nothing keeps the old bytes, so
                this cannot be undone. Writing also reindexes the folder, which
                clears which run produced each file in it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction disabled={upload.isPending} onClick={save}>
                Replace
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Button onClick={cancel} size="xs" variant="ghost">
          Cancel
        </Button>
      </div>
      {failureText(upload.error) === null ? null : (
        <p className="text-destructive text-xs">{failureText(upload.error)}</p>
      )}
    </div>
  );
};

/**
 * The bytes, drawn according to the extension.
 *
 * An image is left to the browser, which streams it straight off the content
 * endpoint; text and JSON are read as text so they can be shown in place, and
 * that read goes through `fetch` rather than the typed client because the
 * endpoint answers raw octets. JSON is re-indented when it parses and shown
 * verbatim when it does not — a file claiming to be JSON and failing to be is
 * exactly the file somebody opened this panel to look at.
 *
 * Text and JSON can also be changed here; an image cannot, since replacing one
 * means bringing a new file rather than typing it.
 */
export const ArtifactPreview = ({
  artifact,
  renderer,
  taskId,
}: PreviewProps) => {
  const href = artifactContentUrl(taskId, artifact.id);
  const text = useQuery({
    enabled: renderer !== "image",
    queryFn: async ({ signal }) => {
      const response = await fetch(href, { credentials: "include", signal });
      if (!response.ok) {
        throw new Error(`The file could not be read (${response.status}).`);
      }
      return await response.text();
    },
    queryKey: [...keys.artifacts(taskId), artifact.id, "content"],
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (renderer === "image") {
    return (
      // biome-ignore lint/performance/noImgElement: this is a Vite app, with no framework image component behind the rule.
      // biome-ignore lint/correctness/useImageSize: an artifact's dimensions are not in the index, and a guessed pair would distort it.
      <img alt={artifact.path} className="max-h-96 rounded-md" src={href} />
    );
  }
  if (text.isPending) {
    return <Skeleton className="h-16 w-full" />;
  }
  if (text.data === undefined) {
    return <p className="text-destructive text-xs">{text.error?.message}</p>;
  }

  return (
    <EditableText
      artifact={artifact}
      renderer={renderer}
      source={text.data}
      taskId={taskId}
    />
  );
};
