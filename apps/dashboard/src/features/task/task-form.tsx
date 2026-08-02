import { useQuery } from "@tanstack/react-query";
import type { Task } from "@workspace/api";
import type { TaskId, TaskStatus } from "@workspace/domain";
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
import {
  NativeSelect,
  NativeSelectOption,
} from "@workspace/ui/components/native-select";
import { Textarea } from "@workspace/ui/components/textarea";
import { type ChangeEvent, useCallback, useState } from "react";
import { projectsQuery } from "@/api/projects";
import { useCreateTask, usePatchTask } from "@/api/tasks";
import { failureText } from "@/features/task/actions";
import {
  CREATABLE_STATUSES,
  draftOf,
  FormField,
  orNull,
  STATUS_LABELS,
  type TaskDraft,
} from "@/features/task/task-fields";

interface TaskFormDialogProps {
  /** Where a new task lands when the form is opened from a column. */
  readonly defaultStatus?: TaskStatus;
  readonly onCreated?: (taskId: TaskId) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  /** Absent files a new task; present edits that one. */
  readonly task?: Task;
}

/**
 * Filing a task by hand, and correcting one.
 *
 * The status choice exists only when creating: a task already on the board
 * moves through the status machine, and a select that quietly rewrote the
 * column would be a second door into it with none of the rules. Which columns
 * are offered is asked of the domain rather than listed here, so the form and
 * the server cannot disagree about where a person may file something.
 */
export const TaskFormDialog = ({
  defaultStatus = "ideas",
  onCreated,
  onOpenChange,
  open,
  task,
}: TaskFormDialogProps) => {
  const [draft, setDraft] = useState(() => draftOf(task, defaultStatus));
  const [seeded, setSeeded] = useState(open);
  const projects = useQuery(projectsQuery());

  // Re-seeding while rendering rather than in an effect keeps a stale draft
  // from being visible for a frame: the dialog can stay mounted between
  // openings, and what it holds has to be the task as it is now.
  if (seeded !== open) {
    setSeeded(open);
    if (open) {
      setDraft(draftOf(task, defaultStatus));
    }
  }

  const create = useCreateTask();
  const patch = usePatchTask();

  const onField = useCallback(
    (
      event: ChangeEvent<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >
    ) => {
      const { name, value } = event.target;
      setDraft((current): TaskDraft => ({ ...current, [name]: value }));
    },
    []
  );

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const submit = useCallback(() => {
    const shared = {
      acceptance: orNull(draft.acceptance),
      projectId: orNull(draft.projectId) as Task["projectId"],
      prUrl: orNull(draft.prUrl),
      repoUrl: orNull(draft.repoUrl),
      sandboxImage: orNull(draft.sandboxImage),
      title: draft.title.trim(),
    };
    if (task === undefined) {
      create.mutate(
        { ...shared, brief: draft.brief, status: draft.status as TaskStatus },
        {
          onSuccess: (created) => {
            onCreated?.(created.id);
            close();
          },
        }
      );
      return;
    }
    patch.mutate(
      { patch: { ...shared, brief: draft.brief }, taskId: task.id },
      { onSuccess: close }
    );
  }, [close, create, draft, onCreated, patch, task]);

  const failed = failureText(create.error ?? patch.error);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {task === undefined ? "New task" : "Edit task"}
          </DialogTitle>
          <DialogDescription>
            The brief is the prompt a run is given; the acceptance criteria are
            appended to it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
          <FormField htmlFor="task-title" label="Title">
            <Input
              id="task-title"
              name="title"
              onChange={onField}
              value={draft.title}
            />
          </FormField>
          <FormField htmlFor="task-form-brief" label="Brief">
            <Textarea
              id="task-form-brief"
              name="brief"
              onChange={onField}
              rows={5}
              value={draft.brief}
            />
          </FormField>
          <FormField htmlFor="task-form-acceptance" label="Acceptance">
            <Textarea
              id="task-form-acceptance"
              name="acceptance"
              onChange={onField}
              rows={3}
              value={draft.acceptance}
            />
          </FormField>
          {task === undefined ? (
            <FormField htmlFor="task-status" label="Column">
              <NativeSelect
                className="w-full"
                id="task-status"
                name="status"
                onChange={onField}
                value={draft.status}
              >
                {CREATABLE_STATUSES.map((status) => (
                  <NativeSelectOption key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormField>
          ) : null}
          <FormField htmlFor="task-project" label="Project">
            <NativeSelect
              className="w-full"
              id="task-project"
              name="projectId"
              onChange={onField}
              value={draft.projectId}
            >
              <NativeSelectOption value="">No project</NativeSelectOption>
              {projects.data?.map((project) => (
                <NativeSelectOption key={project.id} value={project.id}>
                  {project.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormField>
          <FormField htmlFor="task-pr" label="Pull request">
            <Input
              id="task-pr"
              name="prUrl"
              onChange={onField}
              value={draft.prUrl}
            />
          </FormField>
          <FormField htmlFor="task-repo" label="Repository">
            <Input
              id="task-repo"
              name="repoUrl"
              onChange={onField}
              placeholder="inherits the project's"
              value={draft.repoUrl}
            />
          </FormField>
          <FormField htmlFor="task-image" label="Sandbox image">
            <Input
              id="task-image"
              name="sandboxImage"
              onChange={onField}
              placeholder="the default image"
              value={draft.sandboxImage}
            />
          </FormField>
        </div>

        {failed === null ? null : (
          <p className="text-destructive text-xs">{failed}</p>
        )}
        <DialogFooter>
          <Button onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={
              draft.title.trim() === "" || create.isPending || patch.isPending
            }
            onClick={submit}
          >
            {task === undefined ? "File it" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
