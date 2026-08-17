/**
 * What the checker knows about Effect: the brand property names, the `Layer`
 * and `Effect` predicates, the union walk, and turning one requirement member
 * into something the graph can point at.
 *
 * Two rules run through all of it. Type arguments are read structurally, never
 * off `typeToString` — the printer collapses `BunServices` where `getTypes()`
 * returns its six members, and splitting the printed union on `|` shreds
 * `HandleAllRequirements<…>` into nodes named after half a generic. And
 * `getTypeArguments` is called only behind `isTypeReference()`, because the Go
 * server dereferences a nil pointer on anything else and takes the process with
 * it — a crash, not an exception, so there is nothing to catch.
 */

import type { TsChecker, TsType } from "./session";

/** `~effect/Context/Service` — present on a service class's declared type. */
export const SERVICE_BRAND = "~effect/Context/Service";

/** `~effect/Schema/Schema` — present on a tagged error class's statics. */
export const SCHEMA_BRAND = "~effect/Schema/Schema";

/**
 * `TypeFormatFlags.NoTruncation`. Hardcoded because the enum is not exported
 * from the API; without it a union of more than five members prints as
 * `… 10 more …` and the display text lies about what the type is.
 */
const NO_TRUNCATION = 1;

/** `Layer<ROut, E, RIn>` and `Effect<A, E, R>` both carry three arguments. */
const CHANNEL_COUNT = 3;

/** Only `effect`'s own `Layer` counts, not a local type of the same name. */
const EFFECT_DECLARATION = "/node_modules/effect/";

/**
 * The tsgo server is gone. Nothing further can be asked of the checker, so this
 * is the one failure the walk does not absorb.
 */
export class SessionLost extends Error {
  constructor(where: string, options: { readonly cause: unknown }) {
    super(
      `checker session lost at ${where}: ${String(options.cause)}`,
      options
    );
    this.name = "SessionLost";
  }
}

/** A dead transport says so in the message; a type it cannot compute does not. */
const TRANSPORT_FAILURE =
  /socket|pipe|closed|ECONNRESET|EPIPE|disposed|not connected/i;

/**
 * Runs a checker call, recording a failure instead of raising it.
 *
 * One file the checker chokes on costs one node, never the run. The exception
 * is a dead session, which is rethrown because every later call would fail the
 * same way and the report would be a list of thousands.
 */
export const safe = async <A>(
  fn: () => Promise<A>,
  onError: (detail: string) => void,
  where = "unknown"
) => {
  try {
    return await fn();
  } catch (error) {
    if (TRANSPORT_FAILURE.test(String(error))) {
      throw new SessionLost(where, { cause: error });
    }
    onError(String(error));
  }
};

const isFromEffect = async (type: TsType | undefined, name: string) => {
  const symbol = await type?.getSymbol();
  return (
    !!symbol &&
    symbol.name === name &&
    // `NodeHandle.path` is lowercased, so the literal has to be too.
    symbol.declarations.some((declaration) =>
      declaration.path.includes(EFFECT_DECLARATION)
    )
  );
};

/** True when the type is `effect`'s own `Layer`. */
export const isLayer = (type: TsType | undefined) =>
  isFromEffect(type, "Layer");

/** True when the type is `effect`'s own `Effect`. */
export const isEffect = (type: TsType | undefined) =>
  isFromEffect(type, "Effect");

/**
 * The three channels of a `Layer` or an `Effect`, or nothing.
 *
 * The `isTypeReference()` guard is load-bearing twice: it narrows the argument
 * to what `getTypeArguments` accepts, and it is what keeps the server alive.
 */
export const channelsOf = async (checker: TsChecker, type: TsType) => {
  if (!type.isTypeReference()) {
    return;
  }
  const args = await checker.getTypeArguments(type);
  return args.length < CHANNEL_COUNT ? undefined : args;
};

/**
 * The members of a union, with `never` dropped — an empty channel is not a
 * requirement on a type named `never`. A non-union is its own single member.
 */
export const unionMembers = async (type: TsType) => {
  const members = type.isUnionType() ? await type.getTypes() : [type];
  return members.filter(
    (member) => !(member.isIntrinsicType() && member.intrinsicName === "never")
  );
};

/** `typeToString` with truncation off. Display only — never parsed. */
export const typeText = (checker: TsChecker, type: TsType) =>
  checker.typeToString(type, undefined, NO_TRUNCATION);

/**
 * What a vendored service or error is allowed to be named. Initial capital,
 * because Effect states its own type-level markers in these channels too —
 * `Types.unhandled` sits in the error channel of every middleware and names no
 * error at all.
 */
const EXTERNAL_NAME = /^[A-Z][\w$]*$/;

/**
 * One member of a requirement or error channel, described well enough to be
 * matched against a class the walk has seen, or turned into an external node.
 */
export interface TypeRef {
  /** The lowercased declaration path, the key the declaration table uses. */
  readonly declPath: string;
  /** Declared under `node_modules`. */
  readonly external: boolean;
  /** Carries type arguments, so it is a shape rather than a service. */
  readonly generic: boolean;
  readonly name: string;
  /** Printed form, for the `unresolved` entry when the member is not drawable. */
  readonly text: string;
}

/** Describes one channel member, or nothing when it has no symbol to name it. */
export const describeMember = async ({
  checker,
  member,
}: {
  readonly checker: TsChecker;
  readonly member: TsType;
}): Promise<TypeRef | undefined> => {
  const symbol = await member.getSymbol();
  const declaration = symbol?.declarations[0];
  if (!(symbol && declaration)) {
    return;
  }
  const generic = member.isTypeReference()
    ? (await checker.getTypeArguments(member)).length > 0
    : false;
  return {
    declPath: `${declaration.path}|${symbol.name}`,
    external: declaration.path.includes("/node_modules/"),
    generic,
    name: symbol.name,
    text: await typeText(checker, member),
  };
};

/** True when a reference may stand in for a service the atlas does not own. */
export const isDrawableExternal = (ref: TypeRef) =>
  ref.external && !ref.generic && EXTERNAL_NAME.test(ref.name);

/**
 * A vendored type that describes the channel rather than filling it. Dropped
 * without comment: `unhandled` is not a requirement the atlas failed to name,
 * it is Effect saying the channel is open.
 */
export const isChannelMarker = (ref: TypeRef) =>
  ref.external && !EXTERNAL_NAME.test(ref.name);
