import { Effect, Layer } from "effect";
import { TheService } from "./service";

/**
 * A stub of a real service. The extractor must not draw it: a test double is
 * not a provider, and drawing one puts a fake on the production map.
 */
export const stubLayer = Layer.succeed(TheService, {
  label: "stub",
  read: Effect.succeed("stub"),
  transition: () => Effect.void,
});
