import { Layer } from "effect";
import { loggerLayer } from "./logger";
import { type OtlpOptions, otlpLayer } from "./otlp";
import { Telemetry } from "./telemetry";

/**
 * Console logging plus the config-gated OTLP forwarder.
 *
 * The OTLP layer is built over the logger layer on purpose: its logger merges
 * with whatever loggers exist in its own build scope, so composing it this way
 * gives `[console, otlp]` rather than `[default, otlp]`. The logger layer stays
 * exposed, which is what the endpoint-unset case runs on.
 */
export const observabilityLayer = (options: OtlpOptions) =>
  Layer.mergeAll(
    loggerLayer,
    otlpLayer(options).pipe(Layer.provide(loggerLayer))
  );

/**
 * Everything at once: the logger, the OTLP forwarder, and the emitter over its
 * JSONL ledger. Provide a platform `FileSystem` (`BunServices.layer`) under it.
 */
export const telemetryLayer = (options: OtlpOptions) =>
  Layer.mergeAll(
    observabilityLayer(options),
    Telemetry.layer({ serviceName: options.serviceName })
  );
