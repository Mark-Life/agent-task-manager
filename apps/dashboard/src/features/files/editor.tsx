import {
  Cancel01Icon,
  FloppyDiskIcon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { MAX_FILE_BYTES } from "@workspace/api";
import type { FileScope, ScopePath } from "@workspace/domain";
import { Button } from "@workspace/ui/components/button";
import { CodeBlock, Markdown } from "@workspace/ui/components/markdown";
import { Textarea } from "@workspace/ui/components/textarea";
import { type ChangeEvent, useCallback, useState } from "react";
import { scopeFileQuery, useWriteScopeFile } from "@/api/files";
import { Failed, failureSentence, Pending } from "@/components/query-state";
import { InstructionBudget } from "@/features/files/budget";
import { InstructionPairOffer } from "@/features/files/instruction-pair";
import { scopeKeepsHistory } from "@/features/files/scopes";
import { formatBytes } from "@/lib/format";
import { byteLengthOf, isInstructionFile } from "@/lib/instruction-budget";
import { nameOf } from "@/lib/scope-path";

/** Names a document rather than code, and is drawn as one. */
const MARKDOWN_EXTS = new Set(["markdown", "md"]);

/** The extension a renderer dispatches on, lowercased, or nothing where there is none. */
const extOf = (path: string) => {
  const name = nameOf(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? null : name.slice(dot + 1).toLowerCase();
};

interface SourceProps {
  readonly ext: string | null;
  readonly source: string;
}

/**
 * The file as the thing it is: a document rendered, anything else highlighted.
 *
 * Reading and editing are separate on purpose. What gets written back is bytes,
 * and a rendered document is not the bytes — so the box a person types into is
 * always the source, and this is only what they read.
 */
const Rendered = ({ ext, source }: SourceProps) =>
  ext !== null && MARKDOWN_EXTS.has(ext) ? (
    <div className="text-[0.8125rem]">
      <Markdown>{source}</Markdown>
    </div>
  ) : (
    <CodeBlock
      className="[&_pre]:max-h-none [&_pre]:rounded-none [&_pre]:border-0"
      code={source}
      lang={ext ?? undefined}
      lineNumbers
    />
  );

/**
 * The one line above the box, which says a different thing depending on whether
 * a save can be taken back.
 *
 * The shared scopes are git repositories, and an edit here commits — so what is
 * on disk now survives the save. A task's folder has no history at all, and a
 * person about to overwrite a run's only output should be told before they
 * click rather than after.
 */
const editorHint = (input: {
  readonly bytes: number;
  readonly editing: boolean;
  readonly keepsHistory: boolean;
}) => {
  if (!input.editing) {
    return `${formatBytes(input.bytes)} on disk`;
  }
  return input.keepsHistory
    ? "Saving commits this scope's git history, so the bytes on disk now are recoverable."
    : "This folder keeps no history. Saving replaces the old bytes for good.";
};

interface EditorProps {
  /** Where the selection goes when an action here creates a second file. */
  readonly onSelect: (path: ScopePath) => void;
  readonly path: ScopePath;
  readonly scope: FileScope;
}

/**
 * One text file, read and written.
 *
 * A plain box and nothing else. This is where house rules, a project's
 * conventions and a task's notes get typed, and every one of them is prose in a
 * file both agent CLIs read verbatim — an editor that folded, completed or
 * reformatted anything would be an editor that can change what a run is told
 * without anybody asking it to.
 *
 * A file whose bytes did not decode as text is refused rather than shown. The
 * failure that prevents is silent and total: a PNG read as text and saved back
 * is a destroyed file, with no error raised at either end.
 */
export const ScopeFileEditor = ({ onSelect, path, scope }: EditorProps) => {
  const file = useQuery(scopeFileQuery({ path, scope }));
  const write = useWriteScopeFile();
  const { mutate, reset } = write;

  const [draft, setDraft] = useState<string | null>(null);

  const source = file.data?.content ?? "";

  const type = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value),
    []
  );
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
      { content: draft, path, scope },
      { onSuccess: () => setDraft(null) }
    );
  }, [draft, mutate, path, scope]);

  if (file.isPending) {
    return <Pending className="p-4" label="Loading file" lines={6} />;
  }

  if (file.isError) {
    return (
      <Failed
        className="m-4"
        error={file.error}
        onRetry={file.refetch}
        title="That file did not open"
      />
    );
  }

  if (file.data.encoding === "base64") {
    return (
      <p className="p-6 text-center text-muted-foreground text-xs">
        These bytes are not text — {formatBytes(file.data.bytes)} of something
        else. Nothing here will open it, because an editor that read it as text
        would destroy it on the first save.
      </p>
    );
  }

  const editing = draft !== null;
  const shown = draft ?? source;
  const bytes = byteLengthOf(shown);
  const tooLarge = bytes > MAX_FILE_BYTES;
  const failed = failureSentence(write.error);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-border border-b px-3 py-1.5">
        <p className="min-w-0 truncate text-muted-foreground text-xs">
          {editorHint({
            bytes: file.data.bytes,
            editing,
            keepsHistory: scopeKeepsHistory(scope),
          })}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {editing ? (
            <>
              <Button
                disabled={write.isPending || shown === source || tooLarge}
                onClick={save}
                size="sm"
              >
                <HugeiconsIcon icon={FloppyDiskIcon} strokeWidth={2} />
                Save
              </Button>
              <Button
                aria-label="Stop editing"
                onClick={cancel}
                size="icon-sm"
                title="Stop editing"
                variant="ghost"
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            </>
          ) : (
            <Button onClick={edit} size="sm" variant="outline">
              <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
              Edit
            </Button>
          )}
        </div>
      </div>

      {isInstructionFile(path) ? (
        <InstructionBudget draftBytes={bytes} path={path} scope={scope} />
      ) : null}
      <InstructionPairOffer onCreated={onSelect} path={path} scope={scope} />

      {tooLarge ? (
        <p className="shrink-0 border-border border-b px-3 py-1.5 text-destructive text-xs">
          {formatBytes(bytes)} is over the {formatBytes(MAX_FILE_BYTES)} these
          routes accept, so this cannot be saved.
        </p>
      ) : null}
      {failed === null ? null : (
        <p className="shrink-0 border-border border-b px-3 py-1.5 text-destructive text-xs">
          {failed}
        </p>
      )}

      {editing ? (
        <Textarea
          aria-label={`Contents of ${path}`}
          className="field-sizing-fixed min-h-0 w-full flex-1 resize-none rounded-none border-0 font-mono text-xs focus-visible:ring-0"
          onChange={type}
          value={shown}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {source === "" ? (
            <p className="text-muted-foreground text-xs">
              This file is empty. Press Edit to write it.
            </p>
          ) : (
            <Rendered ext={extOf(path)} source={source} />
          )}
        </div>
      )}
    </div>
  );
};
