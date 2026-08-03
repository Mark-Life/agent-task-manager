import type { Project } from "@workspace/api";
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
import { Label } from "@workspace/ui/components/label";
import { Textarea } from "@workspace/ui/components/textarea";
import { type ChangeEvent, type ReactNode, useCallback, useState } from "react";
import { useCreateProject, usePatchProject } from "@/api/projects";
import { failureSentence } from "@/components/query-state";

/** Every field of the form as text, because that is what an input holds. */
interface ProjectDraft {
  readonly description: string;
  readonly name: string;
  readonly repoDefaultBranch: string;
  readonly repoUrl: string;
}

const EMPTY: ProjectDraft = {
  description: "",
  name: "",
  repoDefaultBranch: "",
  repoUrl: "",
};

/** The project as text, or an empty form when there is no project yet. */
const draftOf = (project: Project | undefined): ProjectDraft =>
  project === undefined
    ? EMPTY
    : {
        description: project.description ?? "",
        name: project.name,
        repoDefaultBranch: project.repoDefaultBranch ?? "",
        repoUrl: project.repoUrl ?? "",
      };

/**
 * An empty box means "there is nothing here", which the store spells `null`.
 * Sending the empty string instead would record a repository whose URL is no
 * characters, and everything downstream would then have to guess.
 */
const orNull = (value: string) => {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

interface FormFieldProps {
  readonly children: ReactNode;
  readonly hint?: string;
  readonly htmlFor: string;
  readonly label: string;
}

/** Label above control, one gap, one hint. The whole of the form's layout. */
const FormField = ({ children, hint, htmlFor, label }: FormFieldProps) => (
  <div className="flex flex-col gap-1.5">
    <Label htmlFor={htmlFor}>{label}</Label>
    {children}
    {hint === undefined ? null : (
      <p className="text-muted-foreground text-xs">{hint}</p>
    )}
  </div>
);

interface ProjectFormDialogProps {
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  /** Absent files a new project; present edits that one. */
  readonly project?: Project;
}

/**
 * Filing a project, and correcting one.
 *
 * One dialog does both because the fields are identical and the difference is
 * only which verb the button carries — two components would drift the moment a
 * field is added. A project with no repository is an ordinary project, so
 * everything except the name is genuinely optional and the form says so rather
 * than marking three boxes required and refusing them later.
 */
export const ProjectFormDialog = ({
  onOpenChange,
  open,
  project,
}: ProjectFormDialogProps) => {
  const [draft, setDraft] = useState(() => draftOf(project));
  const [seeded, setSeeded] = useState(open);

  // Re-seeding while rendering rather than in an effect keeps a stale draft
  // from being visible for a frame: the dialog stays mounted between openings,
  // and what it holds has to be the project as it is now.
  if (seeded !== open) {
    setSeeded(open);
    if (open) {
      setDraft(draftOf(project));
    }
  }

  const create = useCreateProject();
  const patch = usePatchProject();

  const onField = useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const { name, value } = event.target;
      setDraft((current): ProjectDraft => ({ ...current, [name]: value }));
    },
    []
  );

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const submit = useCallback(() => {
    const fields = {
      description: orNull(draft.description),
      name: draft.name.trim(),
      repoDefaultBranch: orNull(draft.repoDefaultBranch),
      repoUrl: orNull(draft.repoUrl),
    };
    if (project === undefined) {
      create.mutate(fields, { onSuccess: close });
      return;
    }
    patch.mutate(
      { patch: fields, projectId: project.id },
      { onSuccess: close }
    );
  }, [close, create, draft, patch, project]);

  const failed = failureSentence(create.error ?? patch.error);
  const busy = create.isPending || patch.isPending;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {project === undefined ? "New project" : "Edit project"}
          </DialogTitle>
          <DialogDescription>
            A project groups tasks. The repository is what a run clones; without
            one it gets an empty directory.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <FormField htmlFor="project-name" label="Name">
            <Input
              id="project-name"
              name="name"
              onChange={onField}
              value={draft.name}
            />
          </FormField>
          <FormField htmlFor="project-description" label="Description">
            <Textarea
              id="project-description"
              name="description"
              onChange={onField}
              rows={3}
              value={draft.description}
            />
          </FormField>
          <FormField htmlFor="project-repo" label="Repository">
            <Input
              id="project-repo"
              name="repoUrl"
              onChange={onField}
              placeholder="git@github.com:owner/repo.git"
              value={draft.repoUrl}
            />
          </FormField>
          <FormField
            hint="Where pull requests are opened against. Empty means whatever the clone's HEAD turns out to be."
            htmlFor="project-branch"
            label="Default branch"
          >
            <Input
              id="project-branch"
              name="repoDefaultBranch"
              onChange={onField}
              placeholder="main"
              value={draft.repoDefaultBranch}
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
          <Button disabled={draft.name.trim() === "" || busy} onClick={submit}>
            {project === undefined ? "File it" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
