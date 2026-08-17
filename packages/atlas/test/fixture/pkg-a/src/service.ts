import { Context, Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Denied, NotFound } from "./errors";

/**
 * A service no layer anywhere provides — the fixture's stand-in for a request
 * actor. "Provided by nobody" is a fact about the design, not a defect.
 */
export class Actor extends Context.Service<Actor, { readonly id: string }>()(
  "@fixture/pkg-a/Actor"
) {}

interface TheShape {
  /** Plain data: counted in `memberCount`, drawn as nothing. */
  readonly label: string;
  /** Effectful, and its requirement is vendored. */
  readonly read: Effect.Effect<string, never, FileSystem>;
  /** Effectful behind a call signature, with two errors and one requirement. */
  readonly transition: (
    id: string
  ) => Effect.Effect<void, Denied | NotFound, Actor>;
}

const make: Effect.Effect<TheShape, never, Actor> = Effect.gen(function* () {
  const actor = yield* Actor;
  return {
    label: actor.id,
    read: Effect.gen(function* () {
      yield* FileSystem;
      return "read";
    }),
    transition: (id: string) => Effect.fail(new NotFound({ id })),
  };
});

const fixed: TheShape = {
  label: "fixed",
  read: Effect.succeed("fixed"),
  transition: () => Effect.fail(new Denied({ reason: "fixed" })),
};

export class TheService extends Context.Service<TheService, TheShape>()(
  "@fixture/pkg-a/TheService"
) {
  static readonly layer = Layer.effect(TheService, make);
  /** A second, differently named layer for the same service. */
  static readonly editsLayer = Layer.succeed(TheService, fixed);
}

/**
 * A service whose shape is inferred from the object literal it returns, the way
 * every repository in the real tree is written. Each member's declaration is
 * then the one line of that literal, so `run` is where the atlas has to be
 * followed to `const run` and not left pointing at the `return`.
 */
const makeInferred = Effect.gen(function* () {
  const actor = yield* Actor;
  const run = Effect.succeed(actor.id);
  return { run };
});

export class Inferred extends Context.Service<
  Inferred,
  Effect.Success<typeof makeInferred>
>()("@fixture/pkg-a/Inferred") {}
