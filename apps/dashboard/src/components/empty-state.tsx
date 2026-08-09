import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import { cn } from "@workspace/ui/lib/utils";
import type { ReactNode } from "react";

interface EmptyStateProps {
  /** Whatever gets the reader out of the empty state — a button, a hint. */
  readonly children?: ReactNode;
  readonly className?: string;
  readonly description: ReactNode;
  readonly icon: IconSvgElement;
  readonly title: string;
}

/**
 * A panel with nothing in it, said the same way everywhere.
 *
 * The primitive leaves the frame to its caller — it carries `border-dashed`
 * with no border width — so every bare use of it renders as a paragraph
 * floating in the middle of the panel, indistinguishable from content that
 * failed to arrive. Drawing the outline and the icon once means an empty
 * Messages panel and an empty Files panel read as the same kind of nothing,
 * and neither reads as a bug.
 */
export const EmptyState = ({
  children,
  className,
  description,
  icon,
  title,
}: EmptyStateProps) => (
  <Empty
    className={cn("border border-border border-dashed bg-muted/20", className)}
  >
    <EmptyHeader>
      <EmptyMedia variant="icon">
        <HugeiconsIcon icon={icon} strokeWidth={2} />
      </EmptyMedia>
      <EmptyTitle>{title}</EmptyTitle>
      <EmptyDescription>{description}</EmptyDescription>
    </EmptyHeader>
    {children ? <EmptyContent>{children}</EmptyContent> : null}
  </Empty>
);
