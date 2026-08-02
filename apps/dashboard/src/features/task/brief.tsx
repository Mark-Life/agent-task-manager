import { PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Task } from "@workspace/api";
import type { TaskMetadata } from "@workspace/domain";
import { Button } from "@workspace/ui/components/button";
import { Label } from "@workspace/ui/components/label";
import { Textarea } from "@workspace/ui/components/textarea";
import { type ChangeEvent, type ReactNode, useCallback, useState } from "react";
import { usePatchTask } from "@/api/tasks";
import { failureText } from "@/features/task/actions";

/** How the metadata blob is written when a person is about to edit it. */
const INDENT = 2;

/** What the editor holds: three strings, because a textarea has nothing else. */
interface Draft {
  readonly acceptance: string;
  readonly brief: string;
  readonly metadata: string;
}

const draftOf = (task: Task): Draft => ({
  acceptance: task.acceptance ?? "",
  brief: task.brief,
  metadata: JSON.stringify(task.metadata, null, INDENT),
});

/**
 * Reads the metadata box back, refusing anything that is not an object.
 *
 * The column is a map of keys an agent invented, so an array or a bare number
 * would decode on the wire and then be unreadable by everything that expects to
 * look a key up. Failing here, before the request, is the difference between a
 * correction and a 422.
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
 * Editing happens in place rather than in a dialog because these three fields
 * are the page's subject — a modal would hide the thing being changed behind
 * the form changing it. The metadata blob is edited as raw JSON on purpose:
 * agents put arbitrary keys there, and a form that only knew the keys we
 * thought of would quietly drop the rest.
 */
export const TaskBrief = ({ task }: { readonly task: Task }) => {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const patch = usePatchTask();
  const { mutate } = patch;

  const edit = useCallback(() => setDraft(draftOf(task)), [task]);
  const cancel = useCallback(() => {
    setDraft(null);
    setInvalid(null);
  }, []);

  const onBrief = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const { value } = event.target;
    setDraft((current) =>
      current === null ? null : { ...current, brief: value }
    );
  }, []);

  const onAcceptance = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const { value } = event.target;
      setDraft((current) =>
        current === null ? null : { ...current, acceptance: value }
      );
    },
    []
  );

  const onMetadata = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const { value } = event.target;
    setDraft((current) =>
      current === null ? null : { ...current, metadata: value }
    );
  }, []);

  const save = useCallback(() => {
    if (draft === null) {
      return;
    }
    const parsed = parseMetadata(draft.metadata);
    if (parsed.metadata === null) {
      setInvalid(parsed.error);
      return;
    }
    setInvalid(null);
    mutate(
      {
        patch: {
          acceptance: draft.acceptance.trim() === "" ? null : draft.acceptance,
          brief: draft.brief,
          metadata: parsed.metadata,
        },
        taskId: task.id,
      },
      { onSuccess: cancel }
    );
  }, [cancel, draft, mutate, task.id]);

  if (draft === null) {
    return (
      <section className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <Field label="Brief">
            <p className="whitespace-pre-wrap text-foreground">{task.brief}</p>
          </Field>
          <Button
            aria-label="Edit brief"
            onClick={edit}
            size="icon-sm"
            variant="ghost"
          >
            <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
          </Button>
        </div>
        {task.acceptance === null ? null : (
          <Field label="Acceptance">
            <p className="whitespace-pre-wrap">{task.acceptance}</p>
          </Field>
        )}
        {Object.keys(task.metadata).length === 0 ? null : (
          <Field label="Metadata">
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs">
              {JSON.stringify(task.metadata, null, INDENT)}
            </pre>
          </Field>
        )}
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="task-brief">Brief</Label>
        <Textarea
          id="task-brief"
          onChange={onBrief}
          rows={8}
          value={draft.brief}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="task-acceptance">Acceptance</Label>
        <Textarea
          id="task-acceptance"
          onChange={onAcceptance}
          placeholder="What has to be true for this to be done."
          rows={4}
          value={draft.acceptance}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="task-metadata">Metadata</Label>
        <Textarea
          className="font-mono"
          id="task-metadata"
          onChange={onMetadata}
          rows={6}
          value={draft.metadata}
        />
      </div>
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
    </section>
  );
};

/** One labelled block of read-only prose, so the three fields read as one column. */
const Field = ({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) => (
  <div className="flex flex-1 flex-col gap-1.5 text-muted-foreground text-xs">
    <span className="font-medium text-muted-foreground uppercase tracking-wide">
      {label}
    </span>
    {children}
  </div>
);
