/**
 * Who may talk to this bot, and which workspace their words land in.
 *
 * Identity is held in one environment variable rather than a table:
 *
 * ```
 * TELEGRAM_ALLOWLIST=<telegramUserId>:<workspaceId>:<userId>,<telegramUserId>:…
 * ```
 *
 * A Telegram account is not an account in this system, and nothing in a
 * Telegram update proves which workspace a person belongs to — the mapping has
 * to come from somewhere outside the conversation, and until link codes exist
 * that somewhere is the deployment's own configuration.
 *
 * **A malformed entry fails the layer build.** Not a warning, not a skip. A bot
 * that starts with half an allow-list is a bot that silently ignores somebody,
 * and the failure shows up as a person's messages going nowhere hours later,
 * with nothing in the log that says why. Refusing to start says it at boot, in
 * the one place an operator is already looking.
 *
 * The same reasoning covers a repeated Telegram id: last-wins would route
 * someone's messages into whichever workspace happened to be written second.
 */

import { UserId, WorkspaceId } from "@workspace/domain";
import { Context, Effect, Layer, Schema } from "effect";

/** The separator between entries, and the one inside an entry. */
const ENTRY_SEPARATOR = ",";
const FIELD_SEPARATOR = ":";

/** How many colon-separated fields an entry has. */
const ENTRY_FIELDS = 3;

/**
 * The allow-list could not be read.
 *
 * `entry` is the raw text that failed, which is safe to carry: the variable
 * holds ids, never a secret. Naming it is what turns "the bot will not start"
 * into a one-line fix.
 */
export class AllowlistInvalid extends Schema.TaggedErrorClass<AllowlistInvalid>()(
  "Bot.AllowlistInvalid",
  { detail: Schema.String, entry: Schema.String }
) {
  override get message() {
    return `TELEGRAM_ALLOWLIST entry "${this.entry}" — ${this.detail}`;
  }
}

/** What a Telegram account maps to. */
export interface AllowlistEntry {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
}

/** Decode one `telegramUserId:workspaceId:userId` triple. */
const parseEntry = (raw: string) =>
  Effect.gen(function* () {
    const fields = raw.split(FIELD_SEPARATOR).map((field) => field.trim());
    if (fields.length !== ENTRY_FIELDS) {
      return yield* Effect.fail(
        new AllowlistInvalid({
          detail: `expected ${ENTRY_FIELDS} colon-separated fields, got ${fields.length}`,
          entry: raw,
        })
      );
    }
    const [telegramUserId, workspaceId, userId] = fields as [
      string,
      string,
      string,
    ];
    const parsedId = Number(telegramUserId);
    if (!Number.isSafeInteger(parsedId) || parsedId <= 0) {
      return yield* Effect.fail(
        new AllowlistInvalid({
          detail: "the Telegram user id is not a positive integer",
          entry: raw,
        })
      );
    }
    if (workspaceId.length === 0 || userId.length === 0) {
      return yield* Effect.fail(
        new AllowlistInvalid({
          detail: "the workspace id and the user id are both required",
          entry: raw,
        })
      );
    }
    return {
      entry: {
        userId: UserId.make(userId),
        workspaceId: WorkspaceId.make(workspaceId),
      },
      telegramUserId: parsedId,
    };
  });

/**
 * Parse the whole variable into the lookup the access middleware uses.
 *
 * Empty is an error of its own: an allow-list with nobody on it is a bot that
 * answers no one, which is never what anybody meant to configure.
 */
export const parseAllowlist = Effect.fn("Bot.parseAllowlist")(function* (
  raw: string
) {
  const entries = raw
    .split(ENTRY_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return yield* Effect.fail(
      new AllowlistInvalid({ detail: "the allow-list is empty", entry: raw })
    );
  }
  const byTelegramUserId = new Map<number, AllowlistEntry>();
  for (const raw_ of entries) {
    const parsed = yield* parseEntry(raw_);
    if (byTelegramUserId.has(parsed.telegramUserId)) {
      return yield* Effect.fail(
        new AllowlistInvalid({
          detail: "this Telegram user id appears twice",
          entry: raw_,
        })
      );
    }
    byTelegramUserId.set(parsed.telegramUserId, parsed.entry);
  }
  return byTelegramUserId as ReadonlyMap<number, AllowlistEntry>;
});

/** Build the service's operations over an already-parsed map. */
const makeAllowlist = (
  byTelegramUserId: ReadonlyMap<number, AllowlistEntry>
) => {
  const workspaceIds = [
    ...new Set([...byTelegramUserId.values()].map((e) => e.workspaceId)),
  ];
  return {
    /** What this Telegram account maps to, or null when it is not on the list. */
    lookup: (telegramUserId: number) =>
      byTelegramUserId.get(telegramUserId) ?? null,
    /** Every allow-listed account, for the startup banner and the notice fallback. */
    telegramUserIds: [...byTelegramUserId.keys()] as readonly number[],
    /** Each workspace exactly once — what the periodic scans iterate. */
    workspaceIds: workspaceIds as readonly WorkspaceId[],
  } as const;
};

/** What holding the allow-list gets you. Derived, so a consumer cannot restate it. */
export type AllowlistOps = ReturnType<typeof makeAllowlist>;

/**
 * The allow-list, parsed once.
 *
 * A service rather than a value passed down, because three unrelated things
 * need it — the access middleware, the stuck scan's list of workspaces, and the
 * notification fallback that has to find a chat for a workspace — and threading
 * a map through all three is how one of them ends up with a stale copy.
 */
export class Allowlist extends Context.Service<
  Allowlist,
  ReturnType<typeof makeAllowlist>
>()("@workspace/bot/Allowlist") {
  /** Parse the raw variable and fail the build if it does not hold up. */
  static readonly layer = (raw: string) =>
    Layer.effect(
      Allowlist,
      parseAllowlist(raw).pipe(Effect.map(makeAllowlist))
    );
}
