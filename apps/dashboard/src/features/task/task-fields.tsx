import type { Task } from "@workspace/api";
import { creatableStatuses, type TaskStatus } from "@workspace/domain";
import { Label } from "@workspace/ui/components/label";
import type { ReactNode } from "react";

/**
 * How each column is written wherever a status is shown to a person. The stored
 * values are snake_case identifiers, and reading `in_progress` off a screen is
 * a small tax charged every time; one table pays it once, and every surface
 * that names a column agrees with every other.
 */
export const STATUS_LABELS = {
  backlog: "Backlog",
  done: "Done",
  ideas: "Ideas",
  in_progress: "In progress",
  review: "Review",
} as const satisfies Record<TaskStatus, string>;

/**
 * The columns a person may file a new task straight into, asked of the status
 * machine rather than listed here — the two doors into a column are governed by
 * one table, and a select that named its own set would be a second one.
 */
export const CREATABLE_STATUSES = creatableStatuses("human");

/**
 * What the form holds while it is being filled in: every field a string,
 * because that is what an input gives back. The conversion to nulls and to the
 * task's own types happens once, on submit, rather than on every keystroke.
 */
export interface TaskDraft {
  readonly acceptance: string;
  readonly brief: string;
  readonly projectId: string;
  readonly prUrl: string;
  readonly repoUrl: string;
  readonly sandboxImage: string;
  readonly status: string;
  readonly title: string;
}

/** The form as it opens: an existing task's values, or an empty one in a column. */
export const draftOf = (
  task: Task | undefined,
  status: TaskStatus
): TaskDraft => ({
  acceptance: task?.acceptance ?? "",
  brief: task?.brief ?? "",
  projectId: task?.projectId ?? "",
  prUrl: task?.prUrl ?? "",
  repoUrl: task?.repoUrl ?? "",
  sandboxImage: task?.sandboxImage ?? "",
  status: task?.status ?? status,
  title: task?.title ?? "",
});

/** An empty box means the column is empty, which a patch says with an explicit null. */
export const orNull = (value: string) =>
  value.trim() === "" ? null : value.trim();

interface FormFieldProps {
  readonly children: ReactNode;
  readonly htmlFor: string;
  readonly label: string;
}

/** One labelled control, so every row of the form lines up without repeating the markup. */
export const FormField = ({ children, htmlFor, label }: FormFieldProps) => (
  <div className="flex flex-col gap-1.5">
    <Label htmlFor={htmlFor}>{label}</Label>
    {children}
  </div>
);
