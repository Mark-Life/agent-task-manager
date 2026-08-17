import { Actor, TheService } from "@fixture/pkg-a";
import { Layer } from "effect";

/** A module-level layer. */
export const someLayer = Layer.succeed(Actor, { id: "fixed" });

/** A factory: one `Layer` per call, so it has to be called exactly once. */
export const appLayer = (id: string) =>
  Layer.provide(TheService.layer, Layer.succeed(Actor, { id }));
