import { File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import type { Artifact } from "@workspace/api";
import type { ProjectId } from "@workspace/domain";
import { Badge } from "@workspace/ui/components/badge";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@workspace/ui/components/item";
import { projectArtifactsQuery } from "@/api/artifacts";
import { Failed, Pending } from "@/components/query-state";
import { formatBytes, formatRelative } from "@/lib/format";

/**
 * One file the project keeps, on one line.
 *
 * The path is what matters and is the only thing a reader can act on: the file
 * is mounted into every run in this project, so an agent is told where to look
 * rather than handed the bytes. Nothing here opens: a project file has no
 * promote, no edit and no download, because the endpoints those need belong to
 * the task folder and a button that 404s is worse than no button.
 *
 * The badge says "promoted" where somebody chose the file rather than a run
 * leaving it, which is the one distinction between two files in this folder that
 * a person cannot see from the path.
 */
const ProjectFileRow = ({ file }: { readonly file: Artifact }) => (
  <Item size="xs">
    <ItemMedia variant="icon">
      <HugeiconsIcon icon={File01Icon} strokeWidth={2} />
    </ItemMedia>
    <ItemContent className="min-w-0">
      <ItemTitle className="w-full min-w-0">
        <span className="truncate font-mono" title={file.path}>
          {file.path}
        </span>
      </ItemTitle>
    </ItemContent>
    <ItemActions className="shrink-0 gap-2 text-muted-foreground text-xs">
      {file.promotedAt === null ? null : (
        <Badge variant="outline">promoted</Badge>
      )}
      <span className="tabular-nums">{formatBytes(file.bytes)}</span>
      <span className="max-sm:hidden">{formatRelative(file.modifiedAt)}</span>
    </ItemActions>
  </Item>
);

/**
 * What the project keeps for every task filed under it.
 *
 * This folder is mounted read-write into every run on the project, which is what
 * lets a research task leave a document the next task builds on — and until this
 * panel existed that document was on disk, indexed, and visible to nobody. It
 * opens in place beside the environment files for the same reason those do: it is
 * a short list, empty for most projects, and one click from the project it
 * belongs to instead of two and a back button.
 */
export const ProjectFiles = ({
  projectId,
}: {
  readonly projectId: ProjectId;
}) => {
  const files = useQuery(projectArtifactsQuery(projectId));

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-medium text-sm">Files</h2>

      {files.isPending ? <Pending label="Loading files" lines={2} /> : null}

      {files.isError ? (
        <Failed
          error={files.error}
          onRetry={files.refetch}
          title="Files did not load"
        />
      ) : null}

      {files.data?.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          None. Anything a run writes into this project's folder, and anything
          promoted out of a task, stays here for every later task to read.
        </p>
      ) : null}

      {files.data === undefined || files.data.length === 0 ? null : (
        <ItemGroup className="gap-0.5">
          {files.data.map((file) => (
            <ProjectFileRow file={file} key={file.id} />
          ))}
        </ItemGroup>
      )}
    </section>
  );
};
