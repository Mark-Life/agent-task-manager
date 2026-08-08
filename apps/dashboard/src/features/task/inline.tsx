import { PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Markdown } from "@workspace/ui/components/markdown";
import { cn } from "@workspace/ui/lib/utils";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useState,
} from "react";
import { isHttpUrl, prettyUrl } from "@/lib/url";

/**
 * Inline editing primitives, the shape Notion made familiar: a value on the
 * page is the control that changes it.
 *
 * Read and edit are two renderings of the same value: the read one is a
 * button so a keyboard can reach it, the edit one is a box that arrives
 * already holding the value. Both wrap, both carry the same padding and line
 * box, so a value that reads as three lines is edited as three lines and
 * starting an edit moves nothing on the page. The committed value always comes
 * from props — the server is the record and the cache writes back into the read
 * face — while the draft exists only for as long as editing does. Commit fires on
 * blur and on Enter (Cmd+Enter in an area, where Enter is a newline), and
 * Escape throws the draft away; both keys stop at the element, so editing a
 * value never reads as "close the panel this text sits in".
 *
 * Nothing here knows about tasks, patches or fields: a caller hands over the
 * committed string and what to do with the next one, which keeps these boxes
 * usable on any surface that edits a string.
 */

interface InlineEditProps {
  /** Extra classes on both faces, so the swap does not move the text. */
  readonly className?: string;
  /** A name for what clicking starts, for assistive technology. */
  readonly editLabel: string;
  /** What an unset value renders as — the invitation to fill it in. */
  readonly emptyText: string;
  /** Called with the next value when the edit is committed. */
  readonly onCommit: (next: string) => void;
  /** The value as the record holds it. */
  readonly value: string;
}

interface UseInlineEditOptions {
  /** Whether an emptied box is a real value (clears the field) or a mistake (reverts). */
  readonly allowEmpty?: boolean;
  readonly onCommit: (next: string) => void;
  /** Whitespace policy for committing; single-line text trims, prose does not. */
  readonly trimmed?: boolean;
  readonly value: string;
}

/**
 * The draft lifecycle both primitives share: begin seeds it from the value,
 * escape abandons it, and commit hands it over only when it says something
 * new — an untouched or reverted box is not worth a request.
 */
const useInlineEdit = ({
  allowEmpty = true,
  onCommit,
  trimmed = false,
  value,
}: UseInlineEditOptions) => {
  const [draft, setDraft] = useState<string | null>(null);

  const begin = useCallback(() => setDraft(value), [value]);
  const abandon = useCallback(() => setDraft(null), []);

  const commit = useCallback(() => {
    if (draft === null) {
      return;
    }
    const next = trimmed ? draft.trim() : draft;
    setDraft(null);
    if (next !== value && (allowEmpty || next !== "")) {
      onCommit(next);
    }
  }, [allowEmpty, draft, onCommit, trimmed, value]);

  return {
    abandon,
    begin,
    change: setDraft,
    commit,
    draft,
    editing: draft !== null,
  };
};

/**
 * Editing keys that belong to the box rather than whatever floats around it.
 * Escape reverts this edit and stops here: if it reached a sheet or dialog it
 * would close the panel out from under the edit. `modifiedEnter` lets an area
 * keep Enter for newlines and take Cmd/Ctrl+Enter as the commit instead.
 */
const editKeyHandler =
  (abandon: () => void, commit: () => void, modifiedEnter: boolean) =>
  (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      abandon();
      return;
    }
    const wantsCommit = modifiedEnter
      ? event.key === "Enter" && (event.metaKey || event.ctrlKey)
      : event.key === "Enter";
    if (wantsCommit) {
      event.preventDefault();
      commit();
    }
  };

interface EditBoxProps {
  readonly className?: string;
  readonly onAbandon: () => void;
  readonly onChange: (next: string) => void;
  readonly onCommit: () => void;
  readonly value: string;
}

/**
 * The edit face every one-line value shares: text, a link, whatever the read
 * face turned out to be. It keeps the read face's padding and line box so the
 * swap moves nothing, and it arrives focused because mounting means somebody
 * just asked to change this value.
 *
 * It is a textarea, not an input, because the read faces it stands in for wrap.
 * A title long enough to read as three lines was being edited through a
 * one-line slot: the header collapsed, the panel below it jumped up, and the
 * words being changed were off the right edge behind a horizontal scroll. A
 * textarea sized to its content wraps to the same lines the read face does, so
 * opening and closing an edit moves nothing and the whole value stays visible.
 *
 * One line is still what it holds. Enter commits rather than breaking the line
 * — the handler takes it before the textarea sees it — and a newline arriving
 * by paste is folded into a space on the way into the draft, so the value can
 * never grow a second line the read face would not show.
 */
const EditBox = ({
  className,
  onAbandon,
  onChange,
  onCommit,
  value,
}: EditBoxProps) => {
  const change = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) =>
      onChange(event.target.value.replace(/[\n\r]+/g, " ")),
    [onChange]
  );

  return (
    <textarea
      // oxlint-disable-next-line jsx-a11y/no-autofocus
      autoFocus
      className={cn(
        // `block` on both faces rather than the inline-block a button and a
        // textarea default to: their baselines are taken from different lines
        // once the value wraps, and a line box built around them would sit the
        // two faces at different heights.
        "field-sizing-content -mx-1 block min-h-0 w-full resize-none whitespace-pre-wrap break-words rounded-sm bg-muted/40 px-1 py-0 leading-[inherit] outline-none ring-2 ring-ring/30",
        className
      )}
      onBlur={onCommit}
      onChange={change}
      onKeyDown={editKeyHandler(onAbandon, onCommit, false)}
      rows={1}
      value={value}
    />
  );
};

interface InlineTextProps extends InlineEditProps {
  /** When false, committing an empty box reverts instead of erasing the value. */
  readonly allowEmpty?: boolean;
}

/**
 * One line of the record, edited in place: the title, a URL.
 *
 * The read face is the text itself, padded by nothing; the hover wash is the
 * only hint that pressing it does something, because a permanent border would
 * read as a form on a page that is not one.
 *
 * One line of the record, not one line on the screen: a title long enough
 * wraps, and both faces carry the same padding, line box and wrapping, so the
 * swap never shifts the text vertically or sideways.
 */
export const InlineText = ({
  allowEmpty = true,
  className,
  editLabel,
  emptyText,
  onCommit,
  value,
}: InlineTextProps) => {
  const { abandon, begin, change, commit, draft, editing } = useInlineEdit({
    allowEmpty,
    onCommit,
    trimmed: true,
    value,
  });

  if (!editing) {
    return (
      <button
        aria-label={editLabel}
        className={cn(
          "-mx-1 block w-full whitespace-pre-wrap break-words rounded-sm px-1 py-0 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
          value === "" && "text-muted-foreground",
          className
        )}
        onClick={begin}
        type="button"
      >
        {value === "" ? emptyText : value}
      </button>
    );
  }

  return (
    <EditBox
      className={className}
      onAbandon={abandon}
      onChange={change}
      onCommit={commit}
      value={draft ?? ""}
    />
  );
};

/**
 * A one-line value that is an address: the pull request, the repository.
 *
 * A link's ordinary behaviour is the one people already have in their hands —
 * click it and the page opens, middle-click it and it opens in a tab, copy the
 * address from the context menu — and click-to-edit takes all of that away to
 * buy an edit that is wanted far less often. So a filled URL stays a link, and
 * changing it is a pencil that appears when the row is hovered or focused. An
 * empty one has no link to protect, so the whole row is the invitation to type
 * one, exactly like every other empty property.
 *
 * Text that is not a URL — half-typed, or a field somebody used for a note —
 * behaves as plain inline text rather than as a link that would go nowhere.
 */
export const InlineLink = ({
  className,
  editLabel,
  emptyText,
  onCommit,
  value,
}: InlineEditProps) => {
  const { abandon, begin, change, commit, draft, editing } = useInlineEdit({
    onCommit,
    trimmed: true,
    value,
  });

  if (editing) {
    return (
      <EditBox
        className={className}
        onAbandon={abandon}
        onChange={change}
        onCommit={commit}
        value={draft ?? ""}
      />
    );
  }

  if (!isHttpUrl(value)) {
    return (
      <InlineText
        className={className}
        editLabel={editLabel}
        emptyText={emptyText}
        onCommit={onCommit}
        value={value}
      />
    );
  }

  return (
    <span
      className={cn(
        "group -mx-1 flex w-full items-center gap-1 rounded-sm px-1 hover:bg-muted/60",
        className
      )}
    >
      <a
        className="min-w-0 truncate underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        href={value}
        rel="noreferrer"
        target="_blank"
        title={value}
      >
        {prettyUrl(value)}
      </a>
      <EditPencil label={editLabel} onClick={begin} />
    </span>
  );
};

/**
 * The way into an edit when the value itself has to keep its own clicks: a link
 * that should follow, a document whose links should follow. Quiet until the row
 * is hovered, and always reachable by keyboard.
 */
const EditPencil = ({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}) => (
  <button
    aria-label={label}
    className="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 group-hover:opacity-100"
    onClick={onClick}
    type="button"
  >
    <HugeiconsIcon
      className="size-3.5"
      icon={PencilEdit01Icon}
      strokeWidth={2}
    />
  </button>
);

interface InlineAreaProps extends InlineEditProps {
  /** Where the area starts while editing; it grows with the text. */
  readonly rows?: number;
}

/**
 * A paragraph of the record, edited in place: the brief, the acceptance.
 *
 * Enter is a newline here — committing mid-sentence on Enter is how a form
 * loses text — so commit waits for blur or a modified Enter, and an emptied
 * area is handed over as one, which the caller reads as clearing the field.
 * The edit face keeps the read face's padding and line box, and ignores the
 * minimum the rows attribute would set, so opening an edit moves nothing.
 */
export const InlineArea = ({
  className,
  editLabel,
  emptyText,
  onCommit,
  rows = 4,
  value,
}: InlineAreaProps) => {
  const { abandon, begin, change, commit, draft, editing } = useInlineEdit({
    onCommit,
    value,
  });

  const onChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => change(event.target.value),
    [change]
  );

  if (!editing) {
    return (
      <button
        aria-label={editLabel}
        className={cn(
          "-mx-1 w-full whitespace-pre-wrap rounded-sm px-1 py-0 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
          value === "" && "text-muted-foreground",
          className
        )}
        onClick={begin}
        type="button"
      >
        {value === "" ? emptyText : value}
      </button>
    );
  }

  return (
    <textarea
      // oxlint-disable-next-line jsx-a11y/no-autofocus
      autoFocus
      className={cn(
        "field-sizing-content -mx-1 min-h-0 w-full resize-none whitespace-pre-wrap rounded-sm bg-muted/40 px-1 py-0 leading-[inherit] outline-none ring-2 ring-ring/30",
        className
      )}
      onBlur={commit}
      onChange={onChange}
      onKeyDown={editKeyHandler(abandon, commit, true)}
      rows={rows}
      value={draft ?? ""}
    />
  );
};

/**
 * A document of the record, read as a document and edited as its source.
 *
 * The brief and the acceptance criteria are written by agents in markdown, so
 * shown verbatim they read as punctuation around the sentences. Rendered, they
 * gain links and lists — and a rendered document cannot also be a click-to-edit
 * target, because clicking one of its links would open an edit instead of the
 * page. So this follows the link field's answer: the document keeps its own
 * clicks and the pencil starts the edit. An empty one has no document to
 * protect, so the whole row is the invitation to write one.
 *
 * Editing is the source, not a rich editor. What is stored is markdown, agents
 * write it directly, and a box showing exactly what they will read next is the
 * one that cannot silently rewrite it.
 */
export const InlineMarkdown = ({
  className,
  editLabel,
  emptyText,
  onCommit,
  rows = 6,
  value,
}: InlineAreaProps) => {
  const { abandon, begin, change, commit, draft, editing } = useInlineEdit({
    onCommit,
    value,
  });

  const onChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => change(event.target.value),
    [change]
  );

  if (editing) {
    return (
      <textarea
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        className={cn(
          "field-sizing-content -mx-1 min-h-0 w-full resize-none whitespace-pre-wrap rounded-sm bg-muted/40 px-1 py-0 font-mono text-xs leading-relaxed outline-none ring-2 ring-ring/30",
          className
        )}
        onBlur={commit}
        onChange={onChange}
        onKeyDown={editKeyHandler(abandon, commit, true)}
        rows={rows}
        value={draft ?? ""}
      />
    );
  }

  if (value === "") {
    return (
      <button
        aria-label={editLabel}
        className={cn(
          "-mx-1 w-full rounded-sm px-1 py-0 text-left text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
          className
        )}
        onClick={begin}
        type="button"
      >
        {emptyText}
      </button>
    );
  }

  return (
    <div
      className={cn(
        "group -mx-1 flex items-start gap-1 rounded-sm px-1 hover:bg-muted/60",
        className
      )}
    >
      <Markdown className="min-w-0 flex-1">{value}</Markdown>
      <EditPencil label={editLabel} onClick={begin} />
    </div>
  );
};

interface PropertyRowProps {
  readonly children: ReactNode;
  readonly label: string;
}

/**
 * One property of the record: its name, fixed and quiet, beside the value
 * that carries the control. The constant label width keeps the values lined
 * up as one column even where a value is still empty.
 *
 * The label is set in sentence case rather than small capitals: a column of
 * shouted field names competes with the values, which are the part being read
 * and the part being changed.
 */
export const PropertyRow = ({ children, label }: PropertyRowProps) => (
  <div className="grid grid-cols-[7.5rem_1fr] items-center gap-3 rounded-md py-0.5">
    <span className="text-muted-foreground text-xs">{label}</span>
    <div className="min-w-0">{children}</div>
  </div>
);
