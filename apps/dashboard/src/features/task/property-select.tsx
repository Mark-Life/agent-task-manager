import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from "@workspace/ui/components/select";
import { cn } from "@workspace/ui/lib/utils";
import { useCallback, useMemo } from "react";

/**
 * The one control every property row that chooses from a list is drawn with.
 *
 * Status, project and next session used to be three different controls — a
 * fixed-width select, a full-width select and a native dropdown — which put
 * three box widths and three type sizes in one column of three rows. They are
 * the same gesture, so they are the same control: a value that looks like text
 * until it is hovered, the whole width of the value column, opening one popup
 * shape.
 *
 * Options carry their own decoration rather than the caller styling the popup:
 * a colour for sets a reader learns by colour, a quiet hint for the fact that
 * tells two similar-looking options apart, a group for lists that are really
 * two lists. Nothing here knows what a task is.
 */

export interface PropertyOption<Value extends string> {
  /** Drawn muted, for the option that means "nothing set". */
  readonly dim?: boolean;
  /** Which sub-list this belongs under; ungrouped options are drawn first. */
  readonly group?: string;
  /** The quieter half of the row: what tells this option from a similar one. */
  readonly hint?: string;
  readonly label: string;
  /** A background class for the leading dot, or none for a list without colours. */
  readonly tone?: string;
  readonly value: Value;
}

/** One sub-list of the popup, in the order the options were handed over. */
interface OptionGroup<Value extends string> {
  readonly label: string | undefined;
  readonly options: readonly PropertyOption<Value>[];
}

/**
 * Options split into their groups, keeping the caller's order in both
 * directions: ungrouped options stay at the top, and a group appears where its
 * first member did.
 */
const groupsOf = <Value extends string>(
  items: readonly PropertyOption<Value>[]
): readonly OptionGroup<Value>[] => {
  const order: (string | undefined)[] = [];
  const byGroup = new Map<string | undefined, PropertyOption<Value>[]>();

  for (const item of items) {
    const existing = byGroup.get(item.group);
    if (existing === undefined) {
      order.push(item.group);
      byGroup.set(item.group, [item]);
    } else {
      existing.push(item);
    }
  }

  return order.map((label) => ({ label, options: byGroup.get(label) ?? [] }));
};

/**
 * The colour that says which kind of thing this is, where the set has colours.
 *
 * `self-center` rather than trusting the row: a fixed-size box in a flex line
 * that stretches by default takes the top of it, which puts the dot above the
 * middle of the word it belongs to.
 */
const Dot = ({ tone }: { readonly tone: string | undefined }) =>
  tone === undefined ? null : (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 self-center rounded-full", tone)}
    />
  );

/**
 * The trigger reads as the value, not as a form field: no border, no fill, and
 * the same left edge as the click-to-edit text rows it sits between, so the
 * property column lines up whatever kind of value a row holds.
 */
const TRIGGER_CLASS =
  "-mx-1 h-7 w-full justify-between border-0 bg-transparent px-1 text-sm hover:bg-muted/60 data-[popup-open]:bg-muted/60 dark:bg-transparent dark:hover:bg-muted/60";

interface PropertySelectProps<Value extends string> {
  /** What this chooses, for assistive technology. */
  readonly ariaLabel: string;
  readonly disabled?: boolean;
  readonly items: readonly PropertyOption<Value>[];
  readonly onChange: (next: Value) => void;
  /** What is drawn when the value matches no option — a list still loading. */
  readonly placeholder?: string;
  readonly value: Value;
}

export const PropertySelect = <Value extends string>({
  ariaLabel,
  disabled = false,
  items,
  onChange,
  placeholder = "Empty",
  value,
}: PropertySelectProps<Value>) => {
  const groups = useMemo(() => groupsOf(items), [items]);
  const selected = items.find((item) => item.value === value);

  const onValueChange = useCallback(
    (next: Value | null) => {
      if (next !== null) {
        onChange(next);
      }
    },
    [onChange]
  );

  return (
    <Select onValueChange={onValueChange} value={value}>
      <SelectTrigger
        aria-label={ariaLabel}
        className={TRIGGER_CLASS}
        disabled={disabled}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Dot tone={selected?.tone} />
          <span
            className={cn(
              "truncate",
              (selected === undefined || selected.dim === true) &&
                "text-muted-foreground"
            )}
          >
            {selected?.label ?? placeholder}
          </span>
        </span>
      </SelectTrigger>
      <SelectContent className="w-auto min-w-(--anchor-width) max-w-(--available-width)">
        {groups.map((group) => (
          <SelectGroup key={group.label ?? "ungrouped"}>
            {group.label === undefined ? null : (
              <SelectLabel>{group.label}</SelectLabel>
            )}
            {group.options.map((item) => (
              <SelectItem
                className="pr-7 text-sm"
                key={item.value}
                value={item.value}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Dot tone={item.tone} />
                  <span
                    className={cn(
                      "truncate",
                      item.dim === true && "text-muted-foreground"
                    )}
                  >
                    {item.label}
                  </span>
                  {item.hint === undefined ? null : (
                    <span className="max-w-48 truncate text-muted-foreground text-xs">
                      {item.hint}
                    </span>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
};
