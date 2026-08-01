import {
  Cause,
  Clock,
  Context,
  Effect,
  type Exit,
  Layer,
  Option,
  References,
} from "effect";
import { loadEnvironment } from "./environment";
import type { Environment, EventDefinition, EventFields } from "./event";
import { EventLog } from "./event-log";

/**
 * The wide event is the ledger, not narration, so it is emitted below the
 * configurable floor: an operator quieting a service to `Warn` loses log lines,
 * never rows.
 */
const LEDGER_LOG_LEVEL = "Trace";

/**
 * Drops the keys whose value is null, leaving the rest untouched. Pure.
 */
const withoutNulls = (record: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== null)
  );

/** Emits the one wide event a unit of work leaves behind. */
export interface TelemetryInterface {
  /**
   * Sends one identical record to every sink, under `marker`. Never fails and
   * never interrupts: telemetry cannot abort or mask the work it describes.
   */
  readonly emit: (
    marker: string,
    fields: EventFields
  ) => Effect.Effect<void, never>;
  /** The stamp carried by every row this process writes. */
  readonly environment: Environment;
}

/** Options for {@link Telemetry.layer}. */
export interface TelemetryOptions {
  readonly serviceName: string;
}

const make = Effect.gen(function* () {
  const environment = yield* loadEnvironment;
  const log = yield* EventLog;

  const emit = (marker: string, fields: EventFields) =>
    Effect.gen(function* () {
      const millis = yield* Clock.currentTimeMillis;
      // The marker and the environment are stamped last: they are the
      // emitter's to set, and a field cannot overwrite them.
      const record = {
        ts: new Date(millis).toISOString(),
        ...fields,
        ...environment,
        event: marker,
      };
      // The ledger first: it is the sink that survives everything else. It
      // stores the record whole, nulls included, because JSON tells "no value"
      // apart from "field does not exist".
      yield* log.append(record);
      // The annotation sinks — the console logger, and the OTLP logger merged
      // onto it when the endpoint is set — take the same record with its null
      // fields dropped. An OTLP attribute has no null: the exporter renders one
      // as the string "null", which would make `costUsd` a number on a healthy
      // row and a string on a degraded one, and a backend that infers types
      // stops aggregating the column. An absent attribute is how OTLP says "no
      // value", so the two sinks agree on every field that has one.
      const annotations = withoutNulls(record);
      yield* Effect.logInfo(marker).pipe(
        Effect.annotateLogs(annotations),
        Effect.provideService(References.MinimumLogLevel, LEDGER_LOG_LEVEL)
      );
      // The event is also the span, so a stored row and its trace join.
      yield* Effect.annotateCurrentSpan(annotations);
    }).pipe(Effect.ignoreCause);

  return Telemetry.of({ emit, environment });
});

/**
 * The emit path. One call site per unit of work, wrapped so a full disk, a
 * throwing serializer, or an interrupt stays invisible to the work it
 * describes.
 */
export class Telemetry extends Context.Service<Telemetry, TelemetryInterface>()(
  "@workspace/telemetry/Telemetry"
) {
  static readonly layer = (options: TelemetryOptions) =>
    Layer.effect(Telemetry, make).pipe(
      Layer.provide(EventLog.layer({ serviceName: options.serviceName }))
    );
}

/**
 * Encodes a unit's event through its own schema and emits it under its marker.
 * Encoding happens inside the swallowed region, so a bad field is a dropped row
 * rather than a failed run.
 */
export const emitEvent = <Input>(
  definition: EventDefinition<Input>,
  input: Input
) =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    yield* telemetry.emit(definition.marker, definition.encode(input));
  }).pipe(Effect.ignoreCause);

/**
 * Trace ids for the current span, captured at the top of a unit of work. An
 * `onExit` emit often runs after the span has closed, so read them early and
 * carry them on the accumulator.
 */
export const currentTraceIds = Effect.gen(function* () {
  const span = yield* Effect.option(Effect.currentSpan);
  return {
    spanId: Option.isSome(span) ? span.value.spanId : null,
    traceId: Option.isSome(span) ? span.value.traceId : null,
  };
});

/**
 * The base outcome an exit already tells us: `done` on success, `interrupted`
 * when the fiber was killed, `errored` otherwise. A unit that can distinguish
 * more than this — a timeout, a park — decides for itself and ignores this.
 */
export const outcomeOfExit = (exit: Exit.Exit<unknown, unknown>) => {
  if (exit._tag === "Success") {
    return "done" as const;
  }
  // Only a cause that is nothing but interrupts is an interrupt: work that
  // failed and was then torn down really failed, and reporting it as
  // `interrupted` would hide the error that caused the teardown.
  return Cause.hasInterruptsOnly(exit.cause)
    ? ("interrupted" as const)
    : ("errored" as const);
};

/** What the emit site knows about a finished unit of work, before its own fields. */
export interface WideEventContext<A, E> {
  /** Wall-clock the wrapped work took, measured across every exit path. */
  readonly durationMs: number;
  /** How the work ended — success, typed failure, defect, or interrupt. */
  readonly exit: Exit.Exit<A, E>;
  readonly spanId: string | null;
  readonly traceId: string | null;
}

/**
 * Wraps a unit of work so it leaves exactly one wide event, on every exit path.
 *
 * Trace ids are captured before the work starts, because the emit runs as the
 * span closes; the timer spans the whole of it; and the emit hangs off
 * `Effect.onExit`, so a failure, a defect and an interrupt each write their row
 * rather than only the happy path. This is the single definition of that
 * property — a unit of work that hand-rolls its own emit is how two callers
 * start disagreeing about what "exactly once" means.
 */
export const withWideEvent =
  <Input, A, E>(
    definition: EventDefinition<Input>,
    buildInput: (context: WideEventContext<A, E>) => Input
  ) =>
  <R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const traceIds = yield* currentTraceIds;
      const startedAt = yield* Clock.currentTimeMillis;
      return yield* effect.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const endedAt = yield* Clock.currentTimeMillis;
            yield* emitEvent(
              definition,
              buildInput({
                durationMs: endedAt - startedAt,
                exit,
                ...traceIds,
              })
            );
          })
        )
      );
    });
