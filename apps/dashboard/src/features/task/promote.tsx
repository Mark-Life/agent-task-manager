import type { Artifact } from "@workspace/api";
import { PROMOTION_SCOPES } from "@workspace/api";
import type { TaskId } from "@workspace/domain";
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
import {
  NativeSelect,
  NativeSelectOption,
} from "@workspace/ui/components/native-select";
import {
  type ChangeEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useState,
} from "react";
import { usePromoteArtifact } from "@/api/artifacts";
import { failureText } from "@/lib/failure";

interface PromoteDialogProps {
  readonly artifact: Artifact;
  /** What goes inside the trigger: a word in one place, a mark in another. */
  readonly children?: ReactNode;
  /**
   * The element the trigger becomes. A plain button rather than a component of
   * ours: the primitive clones it to attach its own props, which a wrapper that
   * did not forward them would swallow.
   */
  readonly render: ReactElement;
  readonly taskId: TaskId;
}

/**
 * Promotion, behind a confirmation and a choice of destination.
 *
 * A run's own folder goes with the task that produced it, and the global folder
 * is a read-only mount to every worker, so promoting is how a file becomes
 * something later tasks are handed. It copies the bytes rather than pointing at them, so a
 * later edit to this file cannot retroactively change what another task worked
 * from, and it can only happen once, which is why the way in disappears
 * afterwards instead of staying live and being refused.
 */
export const PromoteDialog = ({
  artifact,
  children,
  render,
  taskId,
}: PromoteDialogProps) => {
  const [scope, setScope] =
    useState<(typeof PROMOTION_SCOPES)[number]>("project");
  const promote = usePromoteArtifact();
  const { mutate } = promote;

  const onScope = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    setScope(event.target.value === "global" ? "global" : "project");
  }, []);

  const confirm = useCallback(() => {
    mutate({ artifactId: artifact.id, scope, taskId });
  }, [artifact.id, mutate, scope, taskId]);

  return (
    <AlertDialog>
      <AlertDialogTrigger render={render}>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Promote {artifact.path}?</AlertDialogTitle>
          <AlertDialogDescription>
            A copy is placed in the shared folder and keeps its own record of
            where it came from. Runs can read those folders and cannot write to
            them, so the copy stays as it is until somebody promotes over it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <NativeSelect className="w-full" onChange={onScope} value={scope}>
          {PROMOTION_SCOPES.map((candidate) => (
            <NativeSelectOption key={candidate} value={candidate}>
              {candidate === "project"
                ? "The project's folder"
                : "The global folder"}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {failureText(promote.error) === null ? null : (
          <p className="text-destructive text-xs">
            {failureText(promote.error)}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={promote.isPending} onClick={confirm}>
            Promote
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
