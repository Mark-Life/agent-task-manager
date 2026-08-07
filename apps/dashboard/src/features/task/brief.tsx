import { PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Task } from "@workspace/api";
import type { TaskMetadata } from "@workspace/domain";
import { Button } from "@workspace/ui/components/button";
import { Label } from "@workspace/ui/components/label";
import { Textarea } from "@workspace/ui/components/textarea";
import { type ChangeEvent, type ReactNode, useCallback, useState } from "react";
import { usePatchTask } from "@/api/tasks";
import { InlineArea } from "@/features/task/inline";
import { failureText } from "@/lib/failure";

/** How the metadata blob is written when a person is about to edit it. */
const INDENT = 2;

/**
 * Reads the metadata box back, refusing anything that is not an object.
 *
 * The column is a map of keys an agent invented, so an array or a bare number
 * would decode on the wire and then be unreadable by everything that expects
 * to look a key up. Failing here, before the request, is the difference
 * between a correction and a 422.
 */
const parseMetadata = (source: string): ParsedMetadata => {
  const text = source.trim();
  if (text === "") {
    return { error: null, metadata: {} };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { error: "Metadata has to be a JSON object.", metadata: null };
    }
    return { error: null, metadata: value as TaskMetadata };
  } catch {
    return { error: "That is not valid JSON.", metadata: null };
  }
};

/** Either the blob or the reason it could not be read, never both. */
interface ParsedMetadata {
  readonly error: string | null;
  readonly metadata: TaskMetadata | null;
}

/**
 * What the task asks for, and what it will be judged by.
 *
 * Both paragraphs edit in place like the rest of the body — click the text,
 * change it, walk away — because they are the page's subject and a form would
 * sit between the reader and the thing being said. The metadata blob is the
 * exception: it is raw JSON on purpose, since agents put arbitrary keys there
 * and a form that only knew the keys we thought of would quietly drop the
 * rest, and JSON needs a parse with a verdict, which is what its explicit
 * save is.
 */
export const TaskBrief = ({ task }: { readonly task: Task }) => {
  const patch = usePatchTask();
  const { mutate } = patch;

  const saveBrief = useCallback(
    (next: string) => mutate({ patch: { brief: next }, taskId: task.id }),
    [mutate, task.id]
  );

  const saveAcceptance = useCallback(
    (next: string) =>
      mutate({
        patch: { acceptance: next === "" ? null : next },
        taskId: task.id,
      }),
    [mutate, task.id]
  );

  const failed = failureText(patch.error);

  return (
    <section className="flex flex-col gap-4">
      <Field label="Brief">
        <InlineArea
          className="text-foreground text-sm/relaxed"
          editLabel="Edit brief"
          emptyText="Add a brief"
          onCommit={saveBrief}
          rows={8}
          value={task.brief}
        />
      </Field>
      <Field label="Acceptance">
        <InlineArea
          className="text-sm/relaxed"
          editLabel="Edit acceptance criteria"
          emptyText="Add acceptance criteria"
          onCommit={saveAcceptance}
          rows={3}
          value={task.acceptance ?? ""}
        />
      </Field>
      <MetadataField task={task} />
      {failed === null ? null : (
        <p className="text-destructive text-xs">{failed}</p>
      )}
    </section>
  );
};

/**
 * The metadata blob, behind a pencil because it is the field a person edits
 * last and wrongliest: the agent writes it, a human mostly reads it, and a
 * malformed save has to be refused in place rather than committed on blur.
 * Editing keeps its own draft and its own verdict, separately from the commit
 * lifecycle the prose fields share.
 */
const MetadataField = ({ task }: { readonly task: Task }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const patch = usePatchTask();
  const { mutate } = patch;

  const edit = useCallback(
    () =>
      setDraft(
        Object.keys(task.metadata).length === 0
          ? ""
          : JSON.stringify(task.metadata, null, INDENT)
      ),
    [task.metadata]
  );
  const cancel = useCallback(() => {
    setDraft(null);
    setInvalid(null);
  }, []);

  const onMetadata = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value);
  }, []);

  const save = useCallback(() => {
    if (draft === null) {
      return;
    }
    const parsed = parseMetadata(draft);
    if (parsed.metadata === null) {
      setInvalid(parsed.error);
      return;
    }
    setInvalid(null);
    mutate(
      { patch: { metadata: parsed.metadata }, taskId: task.id },
      { onSuccess: cancel }
    );
  }, [cancel, draft, mutate, task.id]);

  if (draft === null) {
    if (Object.keys(task.metadata).length === 0) {
      return null;
    }
    return (
      <div className="flex items-start justify-between gap-4">
        <Field label="Metadata">
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-foreground text-xs">
            {JSON.stringify(task.metadata, null, INDENT)}
          </pre>
        </Field>
        <Button
          aria-label="Edit metadata"
          onClick={edit}
          size="icon-sm"
          variant="ghost"
        >
          <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="task-metadata">Metadata</Label>
      <Textarea
        className="font-mono"
        id="task-metadata"
        onChange={onMetadata}
        rows={6}
        value={draft}
      />
      {invalid === null ? null : (
        <p className="text-destructive text-xs">{invalid}</p>
      )}
      {failureText(patch.error) === null ? null : (
        <p className="text-destructive text-xs">{failureText(patch.error)}</p>
      )}
      <div className="flex items-center gap-2">
        <Button disabled={patch.isPending} onClick={save}>
          Save
        </Button>
        <Button onClick={cancel} variant="ghost">
          Cancel
        </Button>
      </div>
    </div>
  );
};

/** One labelled block of prose, so the two paragraphs read as one column. */
const Field = ({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) => (
  <div className="flex flex-1 flex-col gap-1.5">
    <span className="font-medium text-muted-foreground text-xs">{label}</span>
    {children}
  </div>
);
