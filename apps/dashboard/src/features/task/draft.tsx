import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Task } from "@workspace/api";
import type { TaskId, TaskStatus } from "@workspace/domain";
import { Button } from "@workspace/ui/components/button";
import { Sheet, SheetContent } from "@workspace/ui/components/sheet";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { useCreateTask, usePatchTask, useTransitionTask } from "@/api/tasks";
import {
  InlineArea,
  InlineLink,
  InlineText,
  PropertyRow,
} from "@/features/task/inline";
import { ProjectSelect } from "@/features/task/properties";
import { StatusPicker } from "@/features/task/status-select";
import { failureText } from "@/lib/failure";

/**
 * What a task is before it exists: the fields creation accepts, held entirely
 * on this screen. Notion rather than a form — nothing is sent anywhere until
 * a value actually changes, so opening the panel and closing it untouched
 * leaves no trace.
 */
interface TaskDraft {
  readonly acceptance: string | null;
  readonly brief: string;
  readonly projectId: Task["projectId"];
  readonly prUrl: string | null;
  readonly repoUrl: string | null;
  readonly sandboxImage: string | null;
  readonly status: TaskStatus;
  readonly title: string;
}

/** The draft as it opens: a name it can be renamed from, and the column it was opened from. */
const emptyDraft = (status: TaskStatus): TaskDraft => ({
  acceptance: null,
  brief: "",
  projectId: null,
  prUrl: null,
  repoUrl: null,
  sandboxImage: null,
  status,
  title: "Untitled",
});

/**
 * What the draft says, as the patch endpoint takes it — everything except where
 * the task sits, which is not something a patch may change.
 */
const contentsOf = (draft: TaskDraft) => ({
  acceptance: draft.acceptance,
  brief: draft.brief,
  projectId: draft.projectId,
  prUrl: draft.prUrl,
  repoUrl: draft.repoUrl,
  sandboxImage: draft.sandboxImage,
  title: draft.title,
});

/**
 * The draft as a create payload.
 *
 * The column comes from wherever the draft was opened — the board's per-column
 * button files into its own column, the way a Trello list does, and the toolbar
 * files into ideas. It is a row on the panel rather than only an argument, so a
 * person who reached for the wrong column can see and change it before the task
 * exists.
 */
const payloadOf = (draft: TaskDraft) => ({
  ...contentsOf(draft),
  status: draft.status,
});

interface DraftTaskProps {
  /** Where a filed task leads: to itself, opened as a real overlay over the board. */
  readonly onFiled: (taskId: TaskId) => void;
  /** Called with `false` when the panel closes; the draft goes with it. */
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  /** The column the draft was opened from, and the one it files into. */
  readonly status: TaskStatus;
}

/**
 * One not-yet task, over the board.
 *
 * The body is mounted only while the panel is open, so closing and reopening
 * starts from an empty draft rather than from somebody's abandoned half-thought.
 * The panel draws on the same side and width as the task overlay it becomes:
 * filing swaps one for the other without the box moving.
 */
export const DraftTask = ({
  onFiled,
  onOpenChange,
  open,
  status,
}: DraftTaskProps) => {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        aria-label="New task"
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl data-[side=right]:lg:max-w-3xl"
        showCloseButton={false}
        side="right"
      >
        {open ? (
          <DraftBody onClose={close} onFiled={onFiled} status={status} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
};

/**
 * The draft itself.
 *
 * Every commit lands twice: into the local draft the panel is drawn from, and
 * — the first time — into a create request, because a changed value is the
 * decision to keep this task. Edits made while that one request is still out
 * survive it: the latest draft is compared with what was sent and the
 * difference follows as a patch, in the same gesture that swaps this panel
 * for the real task. After a refusal the next commit tries the create again,
 * so nothing typed here is lost to one failed request.
 */
interface DraftBodyProps {
  /** The sheet's way out — the draft is simply dropped. */
  readonly onClose: () => void;
  readonly onFiled: (taskId: TaskId) => void;
  readonly status: TaskStatus;
}

const DraftBody = ({ onClose, onFiled, status }: DraftBodyProps) => {
  const [draft, setDraft] = useState<TaskDraft>(() => emptyDraft(status));
  const latest = useRef(draft);
  /** Whether a create request has been sent for this draft; resets when it fails. */
  const filing = useRef(false);
  const create = useCreateTask();
  const patch = usePatchTask();
  const transition = useTransitionTask();
  const { mutate: file } = create;
  const { mutate: amend } = patch;
  const { mutate: move } = transition;

  const update = useCallback(
    (changes: Partial<TaskDraft>) => {
      const next = { ...latest.current, ...changes };
      latest.current = next;
      setDraft(next);
      if (filing.current) {
        return;
      }
      filing.current = true;
      const sent = payloadOf(next);
      file(sent, {
        onError: () => {
          filing.current = false;
        },
        onSuccess: (created) => {
          const followUp = contentsOf(latest.current);
          if (JSON.stringify(followUp) !== JSON.stringify(contentsOf(next))) {
            amend({ patch: followUp, taskId: created.id });
          }
          // A column chosen while the create was still out is a choice about a
          // task that now exists, so it travels as the move it has become.
          if (latest.current.status !== sent.status) {
            move({ taskId: created.id, to: latest.current.status });
          }
          onFiled(created.id);
        },
      });
    },
    [amend, file, move, onFiled]
  );

  // Picking a column does not file the task. Choosing where something would go
  // is not the decision to keep it — the first thing actually written is.
  const onStatus = useCallback((column: TaskStatus) => {
    const next = { ...latest.current, status: column };
    latest.current = next;
    setDraft(next);
  }, []);

  const onTitle = useCallback(
    (next: string) => update({ title: next }),
    [update]
  );
  const onProject = useCallback(
    (projectId: Task["projectId"]) => update({ projectId }),
    [update]
  );
  const onPrUrl = useCallback(
    (next: string) => update({ prUrl: next === "" ? null : next }),
    [update]
  );
  const onRepoUrl = useCallback(
    (next: string) => update({ repoUrl: next === "" ? null : next }),
    [update]
  );
  const onSandboxImage = useCallback(
    (next: string) => update({ sandboxImage: next === "" ? null : next }),
    [update]
  );
  const onBrief = useCallback(
    (next: string) => update({ brief: next }),
    [update]
  );
  const onAcceptance = useCallback(
    (next: string) => update({ acceptance: next === "" ? null : next }),
    [update]
  );

  const failed = failureText(create.error);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pt-5 pb-8">
      <header className="flex items-start justify-between gap-6">
        <h1 className="min-w-0 flex-1 font-heading font-medium text-lg leading-snug">
          <InlineText
            allowEmpty={false}
            editLabel="Edit title"
            emptyText="Untitled"
            onCommit={onTitle}
            value={draft.title}
          />
        </h1>
        <Button
          aria-label="Close panel"
          onClick={onClose}
          size="icon-sm"
          variant="ghost"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </header>

      <section aria-label="Task properties" className="flex flex-col gap-0.5">
        <PropertyRow label="Status">
          <StatusPicker onChange={onStatus} value={draft.status} />
        </PropertyRow>
        <PropertyRow label="Project">
          <ProjectSelect onChange={onProject} value={draft.projectId} />
        </PropertyRow>
        <PropertyRow label="Pull request">
          <InlineLink
            className="text-sm"
            editLabel="Edit pull request URL"
            emptyText="Empty"
            onCommit={onPrUrl}
            value={draft.prUrl ?? ""}
          />
        </PropertyRow>
        <PropertyRow label="Repository">
          <InlineLink
            className="text-sm"
            editLabel="Edit repository URL"
            emptyText="Empty"
            onCommit={onRepoUrl}
            value={draft.repoUrl ?? ""}
          />
        </PropertyRow>
        <PropertyRow label="Sandbox image">
          <InlineText
            className="text-sm"
            editLabel="Edit sandbox image"
            emptyText="Empty"
            onCommit={onSandboxImage}
            value={draft.sandboxImage ?? ""}
          />
        </PropertyRow>
      </section>

      <section className="flex flex-col gap-4">
        <Field label="Brief">
          <InlineArea
            className="text-foreground text-sm/relaxed"
            editLabel="Edit brief"
            emptyText="Add a brief"
            onCommit={onBrief}
            rows={8}
            value={draft.brief}
          />
        </Field>
        <Field label="Acceptance">
          <InlineArea
            className="text-sm/relaxed"
            editLabel="Edit acceptance criteria"
            emptyText="Add acceptance criteria"
            onCommit={onAcceptance}
            rows={3}
            value={draft.acceptance ?? ""}
          />
        </Field>
      </section>

      {failed === null ? null : (
        <p className="text-destructive text-xs">{failed}</p>
      )}
    </div>
  );
};

/** One labelled block of prose, drawn the same as on the task body. */
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
