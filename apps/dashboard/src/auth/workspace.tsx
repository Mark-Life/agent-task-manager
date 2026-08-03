import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { useCallback, useMemo } from "react";
import { authClient, organization } from "@/auth/client";

/** Below this a workspace is implied by the membership, so nothing is asked. */
const AMBIGUOUS_FROM = 2;

/**
 * Which workspace the session speaks for.
 *
 * The gateway derives the workspace from the credential: with one membership it
 * takes that one and never consults this control, which is why the picker hides
 * itself rather than showing a select with a single option. The moment a second
 * membership exists, every request is refused as ambiguous until something
 * calls `setActive` — so this is the only door out of that state, and it has to
 * be here before the second workspace is.
 */
export const WorkspacePicker = () => {
  const queryClient = useQueryClient();
  const workspaces = authClient.useListOrganizations();
  const active = authClient.useActiveOrganization();

  const items = useMemo(
    () =>
      (workspaces.data ?? []).map((workspace) => ({
        label: workspace.name,
        value: workspace.id,
      })),
    [workspaces.data]
  );

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

  if (items.length < AMBIGUOUS_FROM) {
    return null;
  }

  return (
    <Select
      items={items}
      onValueChange={onValueChange}
      value={active.data?.id ?? null}
    >
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
