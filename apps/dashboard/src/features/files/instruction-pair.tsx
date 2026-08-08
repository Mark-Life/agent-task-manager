/**
 * The offer to give one rule its second name.
 *
 * Claude does not read `AGENTS.md` and Codex does not read `CLAUDE.md`, so a
 * folder holding only the first is a folder whose rules reach one provider. The
 * fix is a file with the same text under the other name — and two copies of a
 * rule are two rules the day somebody edits one, which is what a link avoids.
 *
 * Offered where a person has just written the rules, and never forced: the pair
 * is a convention rather than a requirement, and a folder deliberately aimed at
 * one provider is a legitimate thing to have.
 */

import { Link01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import {
  AGENTS_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_FILE,
  type FileScope,
  type ScopePath,
} from "@workspace/domain";
import { Button } from "@workspace/ui/components/button";
import { useCallback } from "react";
import { scopeListingQuery, useCreateScopeLink } from "@/api/files";
import { failureSentence } from "@/components/query-state";
import { joinScopePath, nameOf, parentOf, scopePathOf } from "@/lib/scope-path";

interface PairProps {
  /** Where the selection goes once the second name exists. */
  readonly onCreated: (path: ScopePath) => void;
  readonly path: ScopePath;
  readonly scope: FileScope;
}

/**
 * Whether the folder holding this `AGENTS.md` is still missing its other half.
 *
 * Anything at the name counts as answered, whatever kind it is: a link, a copy
 * somebody pasted, or the one-line import the seeded folders use. This offers a
 * name that is free, and never second-guesses a file somebody already put there.
 */
const InstructionPair = ({ onCreated, path, scope }: PairProps) => {
  const directory = parentOf(path);
  const listing = useQuery(scopeListingQuery(scope, directory));
  const create = useCreateScopeLink();
  const { mutate } = create;

  const beside = joinScopePath(directory, CLAUDE_INSTRUCTIONS_FILE);
  const link = scopePathOf(beside);

  const make = useCallback(() => {
    if (link !== null) {
      mutate(
        { path: link, scope, target: path },
        { onSuccess: () => onCreated(link) }
      );
    }
  }, [link, mutate, onCreated, path, scope]);

  const taken = listing.data?.some((entry) => entry.path === beside) ?? true;
  if (taken || link === null) {
    return null;
  }

  const failed = failureSentence(create.error);

  return (
    <div className="flex flex-col gap-2 border-border border-b bg-muted/30 px-3 py-2">
      <p className="text-muted-foreground text-xs">
        Claude does not read {AGENTS_INSTRUCTIONS_FILE}. Nothing in this folder
        reaches a Claude run until the same text has a{" "}
        {CLAUDE_INSTRUCTIONS_FILE} beside it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={create.isPending}
          onClick={make}
          size="sm"
          variant="outline"
        >
          <HugeiconsIcon icon={Link01Icon} strokeWidth={2} />
          Link {CLAUDE_INSTRUCTIONS_FILE} to this
        </Button>
        <p className="text-muted-foreground text-xs">
          One file to edit. The two folders this system seeds itself do it the
          other way — a real {CLAUDE_INSTRUCTIONS_FILE} holding one import line
          that points at the {AGENTS_INSTRUCTIONS_FILE} — and both work.
        </p>
      </div>
      {failed === null ? null : (
        <p className="text-destructive text-xs">{failed}</p>
      )}
    </div>
  );
};

/**
 * The offer, for the one file it is about.
 *
 * A guard rather than a branch at the call site, so the editor renders this for
 * every file and this decides. The check is the file's own name: an `AGENTS.md`
 * anywhere in a scope is a document a Claude run cannot see, whether it sits at
 * the root or three folders down.
 */
export const InstructionPairOffer = (props: PairProps) =>
  nameOf(props.path) === AGENTS_INSTRUCTIONS_FILE ? (
    <InstructionPair {...props} />
  ) : null;
