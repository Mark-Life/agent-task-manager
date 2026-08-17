/**
 * Service, method and error nodes: the class classification, the statics scan,
 * and the `has-method` / `method-requires` / `fails-with` edges.
 *
 * The meaning of this codebase is in the method graph, not the layer graph.
 * `repositoriesLayer` has one requirement and one error; `TaskRepo.transition`
 * requires `CurrentActor` and fails five different ways. A layer-only atlas
 * ranks `CurrentActor` at inbound degree zero and draws almost no errors, which
 * is why every effectful member gets a node of its own — and why a member that
 * is not effectful gets none, only a place in `memberCount`.
 */

import { EXTERNAL_PACKAGE_ID, nodeId, type SourceLoc } from "../graph";
import {
  channelsOf,
  isEffect,
  SCHEMA_BRAND,
  SERVICE_BRAND,
  safe,
  typeText,
  unionMembers,
} from "./effect";
import { visitLayer } from "./layers";
import {
  loc,
  memberLoc,
  SignatureKind,
  type TsSymbol,
  type TsType,
  type WalkContext,
} from "./session";

/** Statics the `Context.Service` base contributes; none of them holds a layer. */
const IGNORED_STATICS: ReadonlySet<string> = new Set([
  "of",
  "context",
  "use",
  "useSync",
  "key",
  "stack",
  "Identifier",
  "Service",
  "prototype",
  "pipe",
  "toString",
  "toJSON",
]);

/** Instance members that describe the service machinery rather than the service. */
const IGNORED_MEMBERS: ReadonlySet<string> = new Set([
  "constructor",
  "pipe",
  "toString",
  "toJSON",
  "key",
]);

/** `Effect<A, E, R>`, by position. */
const ERROR_CHANNEL = 1;
const REQUIREMENT_CHANNEL = 2;

/** A coarse role, read off where the service is declared. */
const TAG_BY_LOCATION: readonly {
  readonly tag: string;
  readonly test: (file: string) => boolean;
}[] = [
  {
    tag: "repository",
    test: (file) => file.includes("/db/src/repositories/"),
  },
  {
    tag: "middleware",
    test: (file) => file.endsWith("/api/src/security.ts"),
  },
];

const tagsFor = (file: string) =>
  TAG_BY_LOCATION.filter((entry) => entry.test(file)).map((entry) => entry.tag);

const isDrawableMember = (name: string) =>
  !(name.startsWith("~") || IGNORED_MEMBERS.has(name));

/** The string a `key` or `_tag` property holds, when it holds a literal. */
const literalOf = async (ctx: WalkContext, owner: TsType, property: string) => {
  const symbol = await ctx.checker.getPropertyOfType(owner, property);
  if (!symbol) {
    return;
  }
  const type = await ctx.checker.getTypeOfSymbol(symbol);
  return type?.isStringLiteralType() ? type.value : undefined;
};

/**
 * Classifies one exported class and records whatever it turns out to be.
 * Returns whether it was a service or an error; anything else is left for the
 * layer check.
 */
export const visitClass = async ({
  ctx,
  symbol,
  type,
}: {
  readonly ctx: WalkContext;
  readonly symbol: TsSymbol;
  readonly type: TsType;
}) => {
  const where = `${symbol.declarations[0]?.path ?? "?"}#${symbol.name}`;
  const declaredType = await safe(
    () => ctx.checker.getDeclaredTypeOfSymbol(symbol),
    (detail) => ctx.note({ detail, reason: "checker-error", where }),
    where
  );
  if (!declaredType) {
    return false;
  }
  const members = await ctx.checker.getPropertiesOfType(declaredType);
  const statics = await ctx.checker.getPropertiesOfType(type);
  const memberNames = new Set(members.map((member) => member.name));

  if (memberNames.has(SERVICE_BRAND)) {
    await recordService({ ctx, declaredType, statics, symbol, type });
    return true;
  }
  const staticNames = new Set(statics.map((entry) => entry.name));
  if (staticNames.has(SCHEMA_BRAND) && memberNames.has("_tag")) {
    await recordError({ ctx, declaredType, symbol });
    return true;
  }
  return false;
};

const declarationKey = (symbol: TsSymbol) =>
  `${symbol.declarations[0]?.path ?? "?"}|${symbol.name}`;

const sourceOf = (ctx: WalkContext, symbol: TsSymbol) =>
  loc({
    declaration: symbol.declarations[0],
    project: ctx.project,
    root: ctx.root,
  });

/** Like {@link sourceOf}, following an object-literal entry to what it names. */
const memberSourceOf = (ctx: WalkContext, symbol: TsSymbol) =>
  memberLoc({
    checker: ctx.checker,
    declaration: symbol.declarations[0],
    project: ctx.project,
    root: ctx.root,
  });

/**
 * What the service actually offers.
 *
 * A `Context.Service` class's instance type is the key machinery — the brand,
 * the key literal and one `Service` property — and the shape a caller works
 * with hangs off that property. Reading the class's own members instead finds
 * three framework fields and no methods at all.
 */
const shapeOf = async (ctx: WalkContext, declaredType: TsType) => {
  const property = await ctx.checker.getPropertyOfType(declaredType, "Service");
  return property ? await ctx.checker.getTypeOfSymbol(property) : undefined;
};

const recordService = async ({
  ctx,
  declaredType,
  statics,
  symbol,
  type,
}: {
  readonly ctx: WalkContext;
  readonly declaredType: TsType;
  readonly statics: readonly TsSymbol[];
  readonly symbol: TsSymbol;
  readonly type: TsType;
}) => {
  const source = await sourceOf(ctx, symbol);
  if (!source) {
    ctx.note({
      detail: symbol.name,
      reason: "no-symbol",
      where: declarationKey(symbol),
    });
    return;
  }
  // The instance side first: `HttpApiMiddleware.Service` widens its static
  // `key` to `string` and keeps the literal only on the shape, so reading the
  // statics alone leaves the three access middlewares keyless.
  const key =
    (await literalOf(ctx, declaredType, "key")) ??
    (await literalOf(ctx, type, "key"));
  const id = key
    ? nodeId.serviceByKey(key)
    : nodeId.serviceByDeclaration({ file: source.file, name: symbol.name });
  const shape = await shapeOf(ctx, declaredType);
  const members = shape ? await ctx.checker.getPropertiesOfType(shape) : [];
  const drawable = members.filter((member) => isDrawableMember(member.name));

  ctx.builder.addNode({
    id,
    key,
    kind: "service",
    label: symbol.name,
    memberCount: drawable.length,
    origin: "workspace",
    pkg: ctx.packageIdFor(source.file),
    src: source,
    tags: tagsFor(source.file),
    typeText: await typeText(ctx.checker, shape ?? declaredType),
  });
  ctx.declared.set(declarationKey(symbol), id);

  for (const member of drawable) {
    // biome-ignore lint/performance/noAwaitInLoops: one checker server, one question at a time
    await recordMethod({ ctx, member, service: id });
  }
  for (const entry of statics) {
    if (entry.name.startsWith("~") || IGNORED_STATICS.has(entry.name)) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: one checker server, one question at a time
    const staticType = await safe(
      () => ctx.checker.getTypeOfSymbol(entry),
      (detail) => ctx.note({ detail, reason: "checker-error", where: id })
    );
    if (!staticType) {
      continue;
    }
    await visitLayer({
      ctx,
      name: `${symbol.name}.${entry.name}`,
      staticMember: true,
      symbol: entry,
      type: staticType,
    });
  }
};

/**
 * The three channels of a member's Effect: the member's own type when it is one,
 * otherwise what calling it returns. Nothing when the member is plain data.
 */
const effectChannelsOf = async (ctx: WalkContext, type: TsType) => {
  if (await isEffect(type)) {
    const direct = await channelsOf(ctx.checker, type);
    if (direct) {
      return direct;
    }
  }
  const signatures = await safe(
    () => ctx.checker.getSignaturesOfType(type, SignatureKind.Call),
    () => {
      // A member with no call signatures is data, not a failure to report.
    }
  );
  for (const signature of signatures ?? []) {
    // biome-ignore lint/performance/noAwaitInLoops: the first signature that returns an Effect wins, so later ones are never asked for
    const returned = await ctx.checker.getReturnTypeOfSignature(signature);
    if (returned && (await isEffect(returned))) {
      const channels = await channelsOf(ctx.checker, returned);
      if (channels) {
        return channels;
      }
    }
  }
};

const recordMethod = async ({
  ctx,
  member,
  service,
}: {
  readonly ctx: WalkContext;
  readonly member: TsSymbol;
  readonly service: string;
}) => {
  const memberType = await safe(
    () => ctx.checker.getTypeOfSymbol(member),
    (detail) => ctx.note({ detail, reason: "no-type", where: service })
  );
  if (!memberType) {
    return;
  }
  const channels = await effectChannelsOf(ctx, memberType);
  if (!channels) {
    return;
  }
  const source = await memberSourceOf(ctx, member);
  const id = nodeId.method({ name: member.name, service });
  ctx.builder.addNode({
    id,
    kind: "method",
    label: member.name,
    origin: "workspace",
    pkg: pkgOfMethod({ ctx, service, source }),
    service,
    src: source,
    typeText: await typeText(ctx.checker, memberType),
  });
  ctx.builder.addEdge({ kind: "has-method", source: service, target: id });

  await recordMembers({
    channel: channels[REQUIREMENT_CHANNEL],
    ctx,
    kind: "method-requires",
    source: id,
    targetKind: "service",
  });
  await recordMembers({
    channel: channels[ERROR_CHANNEL],
    ctx,
    kind: "fails-with",
    source: id,
    targetKind: "error",
  });
};

// A member declared on an interface in another file still belongs to the
// package that owns the service, which is what a reader means by "where is it".
const pkgOfMethod = ({
  ctx,
  service,
  source,
}: {
  readonly ctx: WalkContext;
  readonly service: string;
  readonly source: SourceLoc | undefined;
}) =>
  ctx.builder.getNode(service)?.pkg ??
  (source ? ctx.packageIdFor(source.file) : EXTERNAL_PACKAGE_ID);

const recordMembers = async ({
  channel,
  ctx,
  kind,
  source,
  targetKind,
}: {
  readonly channel: TsType | undefined;
  readonly ctx: WalkContext;
  readonly kind: "method-requires" | "fails-with";
  readonly source: string;
  readonly targetKind: "service" | "error";
}) => {
  if (!channel) {
    return;
  }
  for (const member of await unionMembers(channel)) {
    // biome-ignore lint/performance/noAwaitInLoops: one checker server, one question at a time
    await ctx.reference({ kind, member, source, targetKind });
  }
};

const recordError = async ({
  ctx,
  declaredType,
  symbol,
}: {
  readonly ctx: WalkContext;
  readonly declaredType: TsType;
  readonly symbol: TsSymbol;
}) => {
  const source = await sourceOf(ctx, symbol);
  if (!source) {
    ctx.note({
      detail: symbol.name,
      reason: "no-symbol",
      where: declarationKey(symbol),
    });
    return;
  }
  // Never key on the base type's symbol name — for a tagged error it is empty.
  const tag = await literalOf(ctx, declaredType, "_tag");
  const id = tag
    ? nodeId.errorByTag(tag)
    : nodeId.errorByDeclaration({ file: source.file, name: symbol.name });
  ctx.builder.addNode({
    id,
    kind: "error",
    label: symbol.name,
    origin: "workspace",
    pkg: ctx.packageIdFor(source.file),
    src: source,
    tag,
    typeText: await typeText(ctx.checker, declaredType),
  });
  ctx.declared.set(declarationKey(symbol), id);
};
