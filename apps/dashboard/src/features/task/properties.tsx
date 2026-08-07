import { ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { Project, Task } from "@workspace/api";
import { Button } from "@workspace/ui/components/button";
import { useCallback, useState } from "react";
import { projectsQuery } from "@/api/projects";
import { usePatchTask } from "@/api/tasks";
import { InlineLink, InlineText, PropertyRow } from "@/features/task/inline";
import { NextSessionSelect } from "@/features/task/next-session";
import { PropertySelect } from "@/features/task/property-select";
import { failureText } from "@/lib/failure";
import { prettyUrl } from "@/lib/url";

/** The select's spelling of "no project" — null never travels through a value-typed control. */
const NO_PROJECT = "";

/**
 * What the patch endpoint may change, read off the mutation itself so this
 * file and the API cannot drift apart on what a partial task looks like.
 */
type TaskPatchPayload = Parameters<
  ReturnType<typeof usePatchTask>["mutate"]
>[0]["patch"];

/**
 * The project the task belongs to, as a property. Exported for the new-task
 * draft, which edits the same field before the task exists.
 *
 * Project ids are branded, which a select refuses to know about, so the seam
 * is here and only here: out of the control it is a project id again, into it
 * it is one string among the options.
 */
export const ProjectSelect = ({
  onChange,
  value,
}: {
  readonly onChange: (projectId: Task["projectId"]) => void;
  readonly value: Task["projectId"];
}) => {
  const projects = useQuery(projectsQuery());
  const items = [
    { dim: true, label: "No project", value: NO_PROJECT },
    ...(projects.data ?? []).map((project: Project) => ({
      // The repo is what tells two projects with neighbouring names apart, and
      // it is the fact that decides where a run on this task would clone from.
      hint: project.repoUrl === null ? undefined : prettyUrl(project.repoUrl),
      label: project.name,
      value: project.id as string,
    })),
  ];

  const onValueChange = useCallback(
    (next: string) =>
      onChange(next === NO_PROJECT ? null : (next as Task["projectId"])),
    [onChange]
  );

  return (
    <PropertySelect
      ariaLabel="Task project"
      items={items}
      onChange={onValueChange}
      value={value ?? NO_PROJECT}
    />
  );
};

/** One of the fields a task often leaves unset, hidden until asked for. */
interface OptionalField {
  readonly editLabel: string;
  /** Whether a filled value is an address, and so opens rather than edits on click. */
  readonly isUrl: boolean;
  readonly label: string;
  readonly onCommit: (next: string) => void;
  readonly value: string;
}

/** One optional field, as whichever of the two one-line faces it takes. */
const OptionalValue = ({ field }: { readonly field: OptionalField }) => {
  const Face = field.isUrl ? InlineLink : InlineText;
  return (
    <Face
      className="text-sm"
      editLabel={field.editLabel}
      emptyText="Empty"
      onCommit={field.onCommit}
      value={field.value}
    />
  );
};

/**
 * What a task is made of, as one column of settable values.
 *
 * Every row is read and changed in the same place: selects for values from a
 * fixed set, click-to-edit text for the open ones, "Empty" where nothing is
 * set yet. The fields a task hardly ever sets stay out of the way while they
 * are empty, behind one toggle that reveals them all.
 * One mutation serves them all, which is why its failure sits once under the
 * column rather than once per row.
 *
 * Status is not among them. It is the field a reader wants visible whichever
 * panel they are on, so it sits in the header instead of behind this one.
 */
export const TaskProperties = ({ task }: { readonly task: Task }) => {
  const patch = usePatchTask();
  const { mutate } = patch;

  const save = useCallback(
    (changes: TaskPatchPayload) => mutate({ patch: changes, taskId: task.id }),
    [mutate, task.id]
  );

  const saveProject = useCallback(
    (projectId: Task["projectId"]) => save({ projectId }),
    [save]
  );
  const savePrUrl = useCallback(
    (next: string) => save({ prUrl: next === "" ? null : next }),
    [save]
  );
  const saveRepoUrl = useCallback(
    (next: string) => save({ repoUrl: next === "" ? null : next }),
    [save]
  );
  const saveSandboxImage = useCallback(
    (next: string) => save({ sandboxImage: next === "" ? null : next }),
    [save]
  );

  const optional: readonly OptionalField[] = [
    {
      editLabel: "Edit pull request URL",
      isUrl: true,
      label: "Pull request",
      onCommit: savePrUrl,
      value: task.prUrl ?? "",
    },
    {
      editLabel: "Edit repository URL",
      isUrl: true,
      label: "Repository",
      onCommit: saveRepoUrl,
      value: task.repoUrl ?? "",
    },
    {
      editLabel: "Edit sandbox image",
      isUrl: false,
      label: "Sandbox image",
      onCommit: saveSandboxImage,
      value: task.sandboxImage ?? "",
    },
  ];
  const filled = optional.filter((field) => field.value !== "");
  const hidden = optional.filter((field) => field.value === "");

  const [showEmpty, setShowEmpty] = useState(false);
  const toggleEmpty = useCallback(() => setShowEmpty((shown) => !shown), []);

  const failed = failureText(patch.error);

  return (
    <section aria-label="Task properties" className="flex flex-col gap-0.5">
      <PropertyRow label="Project">
        <ProjectSelect onChange={saveProject} value={task.projectId} />
      </PropertyRow>
      <PropertyRow label="Next run">
        <NextSessionSelect task={task} />
      </PropertyRow>
      {filled.map((field) => (
        <PropertyRow key={field.label} label={field.label}>
          <OptionalValue field={field} />
        </PropertyRow>
      ))}
      {hidden.length === 0 ? null : (
        <>
          {showEmpty
            ? hidden.map((field) => (
                <PropertyRow key={field.label} label={field.label}>
                  <OptionalValue field={field} />
                </PropertyRow>
              ))
            : null}
          <Button
            className="mt-0.5 -ml-1 w-fit text-muted-foreground"
            onClick={toggleEmpty}
            size="xs"
            variant="ghost"
          >
            <HugeiconsIcon
              className="size-3"
              icon={showEmpty ? ArrowUp01Icon : ArrowDown01Icon}
              strokeWidth={2}
            />
            {showEmpty ? "Hide empty fields" : "Show empty fields"}
          </Button>
        </>
      )}
      {failed === null ? null : (
        <p className="text-destructive text-xs">{failed}</p>
      )}
    </section>
  );
};
