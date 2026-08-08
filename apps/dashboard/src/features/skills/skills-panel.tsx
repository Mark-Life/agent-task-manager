/**
 * What one directory of the agent filesystem has installed, and how to change
 * it.
 *
 * A skill is not a row anywhere. It is a folder of real files under
 * `<scope>/.agents/skills/<name>`, a link to them at the path the other CLI
 * scans, and one line in that scope's `skills-lock.json` recording where the
 * bytes came from. Everything on this screen is readable in the file browser
 * afterwards, which is the property worth having: a person who prefers to write
 * a skill by hand gets the same layout, and a person debugging one can read
 * every byte of it.
 *
 * Which scope is chosen decides who is handed it, so the audience is written
 * where the choice is made rather than left to be inferred from a folder name.
 */

import {
  Delete02Icon,
  FolderOpenIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { InstalledSkill } from "@workspace/api";
import { type FileScope, fileScopeAddressOf } from "@workspace/domain";
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
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { cn } from "@workspace/ui/lib/utils";
import { useCallback } from "react";
import { scopeSkillsQuery, useUninstallSkill } from "@/api/skills";
import { EmptyState } from "@/components/empty-state";
import { Failed, failureSentence, Pending } from "@/components/query-state";
import { SCOPE_AUDIENCE, SKILL_REACH } from "@/features/files/scopes";
import { InstallSkill } from "@/features/skills/install-skill";
import { SkillUpdateReview } from "@/features/skills/skill-update";
import { scopePathOf } from "@/lib/scope-path";

/** How much of a hash is enough to tell two installs apart by eye. */
const HASH_SHOWN = 12;

/**
 * Where the lock and the disk disagree, said as what a run is getting.
 *
 * Both halves of a skill can be deleted in the file browser, and neither
 * deletion tells anybody. A missing folder means the skill reaches nothing at
 * all; a missing link means it reaches one provider and not the other — two
 * different problems, so two different sentences and not one "broken" badge.
 *
 * Null when the disk holds what the lock claims, which is every ordinary row.
 */
export const skillProblemOf = (skill: InstalledSkill) => {
  if (!skill.present) {
    return {
      badge: "files gone",
      sentence:
        "The lock still claims this skill and its folder is not there, so nothing is handed to a run. Uninstall it, or install it again from the same source.",
      severe: true,
    };
  }
  return skill.linked
    ? null
    : {
        badge: "no link",
        sentence: `The files are there and the link beside them at ${skill.link} is not, so one provider finds this skill and the other does not. Installing again from the same source writes both.`,
        severe: false,
      };
};

interface SkillRowProps {
  readonly scope: FileScope;
  readonly skill: InstalledSkill;
}

/**
 * One installed skill, and what is really on disk for it.
 *
 * `present` and `linked` are drawn rather than assumed. A person can delete
 * either the folder or the link through the file browser, and a list that hid
 * that would be a list of what somebody once installed — the lock row would
 * still be there, and so would the reason a run is not getting the skill.
 */
const SkillRow = ({ scope, skill }: SkillRowProps) => {
  const uninstall = useUninstallSkill();
  const { mutate } = uninstall;

  const remove = useCallback(
    () => mutate({ name: skill.name, scope }),
    [mutate, scope, skill.name]
  );

  const address = fileScopeAddressOf(scope);
  const directory = scopePathOf(skill.directory);
  const failed = failureSentence(uninstall.error);
  const problem = skillProblemOf(skill);

  return (
    <article className="flex flex-col gap-2 rounded-lg border p-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="truncate font-medium font-mono text-sm">{skill.name}</p>
          <p className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
            <span className="font-mono">{skill.source}</span>
            <span className="truncate font-mono">{skill.skillPath}</span>
            <span className="font-mono">
              {skill.computedHash.slice(0, HASH_SHOWN)}
            </span>
          </p>
        </div>
        {problem === null ? null : (
          <Badge variant={problem.severe ? "destructive" : "outline"}>
            {problem.badge}
          </Badge>
        )}
      </header>

      {problem === null ? null : (
        <p
          className={cn(
            "text-xs",
            problem.severe ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {problem.sentence}
        </p>
      )}
      {failed === null ? null : (
        <p className="text-destructive text-xs">{failed}</p>
      )}

      <footer className="flex flex-wrap items-center gap-1">
        {directory === null ? null : (
          <Button
            nativeButton={false}
            render={
              <Link search={{ path: directory, scope: address }} to="/files" />
            }
            size="sm"
            variant="ghost"
          >
            <HugeiconsIcon icon={FolderOpenIcon} strokeWidth={2} />
            Open the files
          </Button>
        )}

        <SkillUpdateReview name={skill.name} scope={scope} />

        <AlertDialog>
          <AlertDialogTrigger
            render={
              <Button
                aria-label={`Uninstall ${skill.name}`}
                size="sm"
                variant="ghost"
              />
            }
          >
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            Uninstall
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Uninstall “{skill.name}”?</AlertDialogTitle>
              <AlertDialogDescription>
                The folder, the link beside it and the lock row go together, so
                nothing is left pointing at nothing. Runs in this scope stop
                being given it. Installing it again from {skill.source} brings
                it back — any edit made to it here does not come back with it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep</AlertDialogCancel>
              <AlertDialogAction
                disabled={uninstall.isPending}
                onClick={remove}
                variant="destructive"
              >
                Uninstall
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </footer>
    </article>
  );
};

interface SkillsPanelProps {
  readonly scope: FileScope;
}

/**
 * The skills of one scope: who gets them, which provider loads them, and the
 * four things a person does to them.
 *
 * A skill written by hand has no lock row and is not in this list. That is not
 * an omission — the lock records where bytes came from, and for a hand-written
 * skill the answer is "somebody wrote them" — so the file browser is where it
 * is, under the same two paths.
 */
export const SkillsPanel = ({ scope }: SkillsPanelProps) => {
  const skills = useQuery(scopeSkillsQuery(scope));

  return (
    <section className="flex flex-col gap-3 p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="font-medium text-sm">{SCOPE_AUDIENCE[scope.scope]}</h2>
          <p className="text-muted-foreground text-xs">{SKILL_REACH}</p>
        </div>
        <InstallSkill scope={scope} />
      </header>

      {skills.isPending ? <Pending label="Loading skills" lines={2} /> : null}

      {skills.isError ? (
        <Failed
          error={skills.error}
          onRetry={skills.refetch}
          title="Skills did not load"
        />
      ) : null}

      {skills.data?.length === 0 ? (
        <EmptyState
          description="Nothing is installed at this level. A run here gets whatever the levels above it carry, and whatever the operator's own skills folder holds."
          icon={SparklesIcon}
          title="No skills installed"
        />
      ) : null}

      {skills.data?.map((skill) => (
        <SkillRow key={skill.name} scope={scope} skill={skill} />
      ))}
    </section>
  );
};
