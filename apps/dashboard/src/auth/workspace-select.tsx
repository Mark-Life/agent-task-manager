import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { useCallback } from "react";
import { organization } from "@/auth/client";

interface WorkspaceSelectProps {
  /** The workspace the session currently speaks for, if one is settled. */
  readonly activeId: string | null;
  readonly items: readonly { readonly label: string; readonly value: string }[];
}

/**
 * The control itself, in its own module because it is the expensive half.
 *
 * A select is one of the larger primitives in the component package — a popup,
 * a positioner and the floating machinery under both — and the picker around
 * this renders nothing at all for an account with a single workspace, which is
 * every account until somebody is invited to a second. Splitting the two means
 * the common case never pays for the control.
 */
export const WorkspaceSelect = ({ activeId, items }: WorkspaceSelectProps) => {
  const queryClient = useQueryClient();

  // Everything read under the old workspace is about rows this session can no
  // longer see, so the cache is dropped whole rather than invalidated key by
  // key — there is no key that survives the switch.
  const choose = useMutation({
    mutationFn: (organizationId: string) =>
      organization.setActive({ organizationId }),
    onSuccess: () => queryClient.clear(),
  });

  // The select's value is nullable because nothing is chosen until a second
  // workspace exists and somebody chooses; clearing it is not an offer this
  // control makes, so a null is ignored rather than sent.
  const { mutate } = choose;
  const onValueChange = useCallback(
    (value: string | null) => {
      if (value !== null) {
        mutate(value);
      }
    },
    [mutate]
  );

  return (
    <Select items={items} onValueChange={onValueChange} value={activeId}>
      <SelectTrigger
        aria-label="Workspace"
        className="w-full"
        disabled={choose.isPending}
        size="sm"
      >
        <SelectValue placeholder="Choose a workspace" />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
