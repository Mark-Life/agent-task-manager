import { useQuery } from "@tanstack/react-query";
import type { Artifact } from "@workspace/api";
import type { TaskId } from "@workspace/domain";
import { CodeBlock, Markdown } from "@workspace/ui/components/markdown";
import { Textarea } from "@workspace/ui/components/textarea";
import type { ChangeEvent } from "react";
import { useCallback } from "react";
import { artifactContentUrl } from "@/api/artifacts";
import { keys } from "@/api/keys";

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

/** Extensions that are a document rather than code, and are drawn as one. */
const MARKDOWN_EXTS = new Set(["markdown", "md"]);

const INDENT = 2;

/**
 * Which renderer a file gets, from its extension alone.
 *
 * The index records the extension and the server deliberately guesses no
 * content type, so this is the only signal there is — and anything unrecognised
 * is offered as a download rather than drawn wrongly.
 */
export const rendererFor = (ext: string | null) => {
  const lower = ext?.toLowerCase() ?? "";
  if (lower === "json") {
    return "json" as const;
  }
  if (MARKDOWN_EXTS.has(lower)) {
    return "markdown" as const;
  }
  if (IMAGE_EXTS.has(lower)) {
    return "image" as const;
  }
  return TEXT_EXTS.has(lower) ? ("text" as const) : ("download" as const);
};

/** What `rendererFor` can answer. */
export type Renderer = ReturnType<typeof rendererFor>;

/** Whether a file is one this app can put in a box and let somebody retype. */
export const isEditable = (renderer: Renderer) =>
  renderer !== "download" && renderer !== "image";

/** Pretty-printed when it parses, verbatim when it does not. */
export const reindent = (source: string) => {
  try {
    return JSON.stringify(JSON.parse(source), null, INDENT);
  } catch {
    return source;
  }
};

/**
 * The bytes as text.
 *
 * Through `fetch` rather than the typed client, because the content endpoint
 * answers raw octets. Cached forever: a file's bytes only change when somebody
 * writes them, and writing goes through the upload, which invalidates this.
 */
export const useArtifactText = (
  taskId: TaskId,
  artifact: Artifact,
  enabled: boolean
) => {
  const href = artifactContentUrl(taskId, artifact.id);
  return useQuery({
    enabled,
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
};

interface FileBodyProps {
  readonly ext: Artifact["ext"];
  readonly renderer: Renderer;
  readonly source: string;
}

/**
 * A file as the thing it is: a document rendered, code highlighted.
 *
 * The extension is the only signal about the contents, and it is passed to the
 * highlighter as the language name — its own aliases cover the short forms, and
 * anything it does not know falls back to plain text, which is a file drawn
 * without colour rather than a file drawn wrongly. Lines are numbered because
 * this is a whole file: the thing a reader wants to say about it is where in it
 * something is.
 *
 * No height of its own: the panel around it decides how tall a file may be.
 */
export const FileBody = ({ ext, renderer, source }: FileBodyProps) => {
  if (renderer === "markdown") {
    return (
      <div className="text-[0.8125rem]">
        <Markdown>{source}</Markdown>
      </div>
    );
  }

  return (
    <CodeBlock
      className="[&_pre]:max-h-none [&_pre]:rounded-none [&_pre]:border-0"
      code={renderer === "json" ? reindent(source) : source}
      lang={ext ?? undefined}
      lineNumbers
    />
  );
};

interface FileSourceProps {
  readonly onChange: (next: string) => void;
  readonly value: string;
}

/**
 * The file as its source.
 *
 * Always the source, never the rendered document: what gets written back is
 * bytes, and a rendered document is not the bytes.
 */
export const FileSource = ({ onChange, value }: FileSourceProps) => {
  const change = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value),
    [onChange]
  );

  return (
    <Textarea
      className="h-full min-h-0 resize-none rounded-none border-0 font-mono focus-visible:ring-0"
      onChange={change}
      value={value}
    />
  );
};
