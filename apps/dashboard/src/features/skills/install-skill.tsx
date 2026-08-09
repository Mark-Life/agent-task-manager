import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type FileScope,
  type SkillName,
  type SkillSourcePath,
  skillNameRefusalOf,
} from "@workspace/domain";
import { Button } from "@workspace/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { type ChangeEvent, useCallback, useState } from "react";
import { useInstallSkill } from "@/api/skills";
import { failureSentence } from "@/components/query-state";
import { SCOPE_AUDIENCE } from "@/features/files/scopes";
import { REPO_URL_PLACEHOLDER, repoUrlProblem } from "@/lib/repo-url";
import { scopePathProblem } from "@/lib/scope-path";

/** What a skill's own file is called, which is what the path has to end in. */
const SKILL_FILE = "SKILL.md";

/** What each refusal of a name means to the person typing it. */
const NAME_REFUSALS: Record<string, string> = {
  empty: "Give it a name, or leave the box empty to use the source's own.",
  not_one_segment:
    "One directory name: letters, digits, dots, dashes and underscores, starting with a letter or a digit.",
  too_long: "That name is longer than a skill directory accepts.",
};

/** The complaint about an overriding name, or null when there is nothing to say. */
const nameProblem = (name: string) => {
  if (name === "") {
    return null;
  }
  const refusal = skillNameRefusalOf(name);
  return refusal === null ? null : (NAME_REFUSALS[refusal] ?? "Not a name.");
};

/** The complaint about the path to the skill file, which has to end at one. */
const pathProblem = (path: string) => {
  if (path === "") {
    return null;
  }
  const problem = scopePathProblem(path);
  if (problem !== null) {
    return problem;
  }
  return path.endsWith(`/${SKILL_FILE}`) || path === SKILL_FILE
    ? null
    : `Point at the ${SKILL_FILE} itself. The skill is the folder holding it, and everything in that folder comes with it.`;
};

interface InstallProps {
  readonly scope: FileScope;
}

/**
 * Installing a skill, which is fetching a folder from GitHub and writing it into
 * one directory of this tree.
 *
 * Three boxes and no registry: a repository, the path of a `SKILL.md` inside it,
 * and a name only when the source's own would collide with something already
 * installed. The credential is the one this system already clones with, so a
 * private repository the board can reach is one a skill can come from.
 *
 * The audience is repeated here, next to the button that commits to it. A skill
 * installed into the workspace folder reaches every run of every project, and
 * that is not a thing to learn afterwards from a list.
 */
export const InstallSkill = ({ scope }: InstallProps) => {
  const [open, setOpen] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");

  const install = useInstallSkill();
  const { mutate, reset } = install;

  const onRepoUrl = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setRepoUrl(event.target.value),
    []
  );
  const onPath = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setPath(event.target.value),
    []
  );
  const onName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );
  const close = useCallback(() => setOpen(false), []);

  const trimmedRepo = repoUrl.trim();
  const trimmedPath = path.trim();
  const trimmedName = name.trim();

  const repoIssue = trimmedRepo === "" ? null : repoUrlProblem(trimmedRepo);
  const pathIssue = pathProblem(trimmedPath);
  const nameIssue = nameProblem(trimmedName);
  const ready =
    trimmedRepo !== "" &&
    trimmedPath !== "" &&
    repoIssue === null &&
    pathIssue === null &&
    nameIssue === null;

  const submit = useCallback(() => {
    mutate(
      {
        install: {
          path: trimmedPath as SkillSourcePath,
          repoUrl: trimmedRepo,
          ...(trimmedName === "" ? {} : { name: trimmedName as SkillName }),
        },
        scope,
      },
      {
        onSuccess: () => {
          setOpen(false);
          setRepoUrl("");
          setPath("");
          setName("");
          reset();
        },
      }
    );
  }, [mutate, reset, scope, trimmedName, trimmedPath, trimmedRepo]);

  const failed = failureSentence(install.error);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
        Install a skill
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Install a skill</DialogTitle>
          <DialogDescription>
            {SCOPE_AUDIENCE[scope.scope]} The folder holding the {SKILL_FILE} is
            copied in whole, and where it came from is recorded so an update can
            be checked later.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="skill-repo">Repository</Label>
          <Input
            className="font-mono text-xs"
            id="skill-repo"
            onChange={onRepoUrl}
            placeholder={REPO_URL_PLACEHOLDER}
            value={repoUrl}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="skill-path">Path to the {SKILL_FILE}</Label>
          <Input
            className="font-mono text-xs"
            id="skill-path"
            onChange={onPath}
            placeholder={`skills/writing/${SKILL_FILE}`}
            value={path}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="skill-name">Name</Label>
          <Input
            className="font-mono text-xs"
            id="skill-name"
            onChange={onName}
            placeholder="the folder's own name"
            value={name}
          />
          <p className="text-muted-foreground text-xs">
            Optional. The folder holding the {SKILL_FILE} names it, and this
            overrides that — which is what two sources offering the same name
            need.
          </p>
        </div>

        {repoIssue === null ? null : (
          <p className="text-destructive text-xs">{repoIssue}</p>
        )}
        {pathIssue === null ? null : (
          <p className="text-destructive text-xs">{pathIssue}</p>
        )}
        {nameIssue === null ? null : (
          <p className="text-destructive text-xs">{nameIssue}</p>
        )}
        {failed === null ? null : (
          <p className="text-destructive text-xs">{failed}</p>
        )}

        <DialogFooter>
          <Button onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button disabled={install.isPending || !ready} onClick={submit}>
            Install
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
