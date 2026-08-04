import type { Actor } from "@workspace/domain";
import { Context, Effect, Layer } from "effect";

/**
 * Who is performing a write, carried as a service requirement rather than as a
 * parameter.
 *
 * Three kinds of writer share this database and two of them are agents, so
 * "who changed this row" has to be answerable for every mutation. Passing the
 * actor as an argument would make that a convention, and a convention is one
 * hurried call site away from a hole in the trail. As a requirement it is the
 * compiler's problem: a mutation reached with nobody in context does not
 * typecheck.
 *
 * There is deliberately no default. A fallback actor is the value every
 * forgotten call site would quietly attribute itself to, and the audit log
 * would look complete while naming the wrong writer.
 */
export class CurrentActor extends Context.Service<CurrentActor, Actor>()(
  "@workspace/db/CurrentActor"
) {
  /**
   * The actor for a whole process — the orchestrator loop, a seed script —
   * where every write in the process is by the same one.
   */
  static readonly layer = (actor: Actor) => Layer.succeed(CurrentActor, actor);
}

/**
 * Runs `effect` as `actor`. The per-request form: a gateway handler resolves
 * who the caller is, scopes the repositories to them for that request, and
 * nothing outside it inherits the answer.
 */
export const withActor =
  (actor: Actor) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, CurrentActor, actor);
