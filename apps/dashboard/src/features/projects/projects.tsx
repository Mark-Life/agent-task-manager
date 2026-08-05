import {
  Delete02Icon,
  FolderLibraryIcon,
  Key01Icon,
  PencilEdit01Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { Project } from "@workspace/api";
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
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@workspace/ui/components/item";
import { useCallback, useState } from "react";
import { projectsQuery, useDeleteProject } from "@/api/projects";
import { Failed, Pending } from "@/components/query-state";
import { ProjectEnvFiles } from "@/features/projects/env-files";
import { ProjectFormDialog } from "@/features/projects/project-form";

interface ProjectRowProps {
  readonly onEdit: (project: Project) => void;
  readonly project: Project;
}

/**
 * One project, and the three things that can be done to it.
 *
 * Deleting sits behind a confirmation that says what survives rather than
 * asking whether the reader is sure: the tasks filed under a project outlive it
 * and come back with no project at all, which is a smaller event than the word
 * "delete" suggests and worth saying before rather than after.
 *
 * The environment files open in place rather than on a screen of their own. It
 * is a list of paths, it is empty for most projects, and a row that expands is
 * one click from the project it belongs to instead of two and a back button.
 */
const ProjectRow = ({ onEdit, project }: ProjectRowProps) => {
  const remove = useDeleteProject();
  const { mutate } = remove;
  const [showEnv, setShowEnv] = useState(false);

  const edit = useCallback(() => onEdit(project), [onEdit, project]);
  const confirm = useCallback(() => mutate(project.id), [mutate, project.id]);
  const toggleEnv = useCallback(() => setShowEnv((shown) => !shown), []);

  return (
    <div className="flex flex-col gap-2">
      <Item variant="outline">
        <ItemContent>
          <ItemTitle>{project.name}</ItemTitle>
          {project.description === null ? null : (
            <ItemDescription>{project.description}</ItemDescription>
          )}
          {project.repoUrl === null ? null : (
            <span className="truncate font-mono text-muted-foreground text-xs">
              {project.repoUrl}
              {project.repoDefaultBranch === null
                ? ""
                : ` · ${project.repoDefaultBranch}`}
            </span>
          )}
        </ItemContent>
        <ItemActions>
          {/* Only a project with a repository has a checkout to write files
            into, so a project without one is not offered the panel. */}
          {project.repoUrl === null ? null : (
            <Button
              aria-expanded={showEnv}
              aria-label={`Environment files for ${project.name}`}
              onClick={toggleEnv}
              size="icon-sm"
              variant="ghost"
            >
              <HugeiconsIcon icon={Key01Icon} strokeWidth={2} />
            </Button>
          )}
          <Button
            aria-label={`Edit ${project.name}`}
            onClick={edit}
            size="icon-sm"
            variant="ghost"
          >
            <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  aria-label={`Delete ${project.name}`}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete “{project.name}”?</AlertDialogTitle>
                <AlertDialogDescription>
                  Its tasks stay on the board and lose their project. Nothing
                  else goes with it, and there is no undo.
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
        </ItemActions>
      </Item>
      {showEnv ? (
        <div className="rounded-md border border-dashed px-4 py-3">
          <ProjectEnvFiles projectId={project.id} />
        </div>
      ) : null}
    </div>
  );
};

/**
 * Every project in the workspace, and the whole of their lifecycle.
 *
 * The list is deliberately flat and quiet: a project is a name and, sometimes,
 * a repository, and there is nothing here worth a chart. One dialog serves both
 * filing and editing, so which one it is doing is a piece of state on this
 * screen rather than two components that would have to be kept the same.
 */
export const Projects = () => {
  const projects = useQuery(projectsQuery());
  const [editing, setEditing] = useState<Project | undefined>(undefined);
  const [open, setOpen] = useState(false);

  const openNew = useCallback(() => {
    setEditing(undefined);
    setOpen(true);
  }, []);

  const openEdit = useCallback((project: Project) => {
    setEditing(project);
    setOpen(true);
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <header className="flex items-center justify-between gap-4">
        <h1 className="font-heading font-medium text-base">Projects</h1>
        <Button onClick={openNew} size="sm">
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
          New project
        </Button>
      </header>

      {projects.isPending ? (
        <Pending label="Loading projects" lines={4} />
      ) : null}

      {projects.isError ? (
        <Failed
          error={projects.error}
          onRetry={projects.refetch}
          title="Projects did not load"
        />
      ) : null}

      {projects.data?.length === 0 ? (
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={FolderLibraryIcon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>No projects yet</EmptyTitle>
            <EmptyDescription>
              A task can live without one. A project is what gives a run a
              repository to clone.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={openNew} size="sm" variant="outline">
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
              New project
            </Button>
          </EmptyContent>
        </Empty>
      ) : null}

      {projects.data === undefined || projects.data.length === 0 ? null : (
        <ItemGroup className="gap-2">
          {projects.data.map((project) => (
            <ProjectRow key={project.id} onEdit={openEdit} project={project} />
          ))}
        </ItemGroup>
      )}

      <ProjectFormDialog onOpenChange={setOpen} open={open} project={editing} />
    </div>
  );
};
