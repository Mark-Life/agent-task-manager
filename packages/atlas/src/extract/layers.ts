/**
 * Layer nodes — module-level constants and the factories that return one —
 * with the `provides` and `requires` edges read off `Layer<ROut, E, RIn>`.
 *
 * A factory is the same node with `parameterized: true`, not a kind of its own.
 * It matters because layer memoisation is by identity: `storeLayer(options)`
 * called twice is two connection pools, and the type is where the atlas can see
 * that a call is required at all.
 */

import type { Node } from "typescript/unstable/ast";
import {
  isIdentifier,
  isPropertyAccessExpression,
} from "typescript/unstable/ast/is";
import { nodeId } from "../graph";
import { channelsOf, isLayer, safe, typeText, unionMembers } from "./effect";
import {
  declarationNode,
  nodeLoc,
  SignatureKind,
  type TsSymbol,
  type TsType,
  type WalkContext,
} from "./session";

/** `Layer<ROut, E, RIn>`, by position. */
const ROUT = 0;
const RIN = 2;

/**
 * The `Layer` combinators that build one layer out of others. The result keeps
 * the type of what survives and nothing of what went in, so a layer written
 * with any of them provides more than the graph can show.
 */
const COMPOSING = new Set(["provide", "provideMerge", "unwrap"]);

/**
 * Whether this declaration composes other layers.
 *
 * Read off the syntax rather than the type, because the type is exactly what
 * erases the answer: `Layer.provide(routes, store)` states the requirements it
 * satisfied, never the layer that satisfied them.
 */
const composesLayers = (node: Node): boolean => {
  if (
    isPropertyAccessExpression(node) &&
    isIdentifier(node.expression) &&
    node.expression.text === "Layer" &&
    COMPOSING.has(node.name.text)
  ) {
    return true;
  }
  return node.forEachChild(composesLayers) ?? false;
};

/**
 * The layer type behind a symbol: the type itself, or what its first call
 * signature returns. Nothing when the symbol is neither.
 */
const layerTypeOf = async (ctx: WalkContext, type: TsType, where: string) => {
  if (await isLayer(type)) {
    return { parameterized: false, type };
  }
  const signatures = await safe(
    () => ctx.checker.getSignaturesOfType(type, SignatureKind.Call),
    (detail) => ctx.note({ detail, reason: "checker-error", where }),
    where
  );
  const first = signatures?.[0];
  if (!first) {
    return;
  }
  const returned = await ctx.checker.getReturnTypeOfSignature(first);
  return returned && (await isLayer(returned))
    ? { parameterized: true, type: returned }
    : undefined;
};

/**
 * Records a layer node and its two edge sets, or nothing when the symbol is not
 * a layer. Returns whether it was one.
 */
export const visitLayer = async ({
  ctx,
  symbol,
  type,
  name,
  staticMember,
}: {
  readonly ctx: WalkContext;
  readonly symbol: TsSymbol;
  readonly type: TsType;
  /** `storeLayer`, or `WorkspaceRepo.layer` for a static. */
  readonly name: string;
  readonly staticMember: boolean;
}) => {
  const where = `${symbol.declarations[0]?.path ?? "?"}#${name}`;
  const found = await layerTypeOf(ctx, type, where);
  if (!found) {
    return false;
  }
  const declared = await declarationNode({
    declaration: symbol.declarations[0],
    project: ctx.project,
  });
  if (!declared) {
    ctx.note({ detail: name, reason: "no-symbol", where });
    return true;
  }
  const source = nodeLoc({ node: declared, root: ctx.root });

  const id = nodeId.layer({ file: source.file, name });
  ctx.builder.addNode({
    composed: composesLayers(declared),
    id,
    kind: "layer",
    label: name,
    origin: "workspace",
    parameterized: found.parameterized,
    pkg: ctx.packageIdFor(source.file),
    src: source,
    staticMember,
    typeText: await typeText(ctx.checker, found.type),
  });

  const channels = await channelsOf(ctx.checker, found.type);
  if (!channels) {
    ctx.note({ detail: name, reason: "opaque-requirement", where: id });
    return true;
  }
  await recordChannel({ channel: RIN, channels, ctx, id, kind: "requires" });
  await recordChannel({ channel: ROUT, channels, ctx, id, kind: "provides" });
  return true;
};

const recordChannel = async ({
  channel,
  channels,
  ctx,
  id,
  kind,
}: {
  readonly channel: number;
  readonly channels: readonly TsType[];
  readonly ctx: WalkContext;
  readonly id: string;
  readonly kind: "provides" | "requires";
}) => {
  const slot = channels[channel];
  if (!slot) {
    return;
  }
  for (const member of await unionMembers(slot)) {
    // biome-ignore lint/performance/noAwaitInLoops: one checker server, one question at a time
    await ctx.reference({ kind, member, source: id, targetKind: "service" });
  }
};
