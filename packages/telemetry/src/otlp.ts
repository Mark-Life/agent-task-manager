import { Config, Effect, Layer, Option } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Otlp from "effect/unstable/observability/Otlp";
import { serviceVersionConfig } from "./environment";

/**
 * Parses the standard `OTEL_EXPORTER_OTLP_HEADERS` shape (`k1=v1,k2=v2`) into a
 * header record. Splits each entry on the FIRST `=` so a value may itself
 * contain `=` — a `Bearer` or base64 credential survives intact. Blank and
 * malformed entries are skipped.
 */
export const parseOtlpHeaders = (raw: string) => {
  const headers: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    const separator = trimmed.indexOf("=");
    if (trimmed.length === 0 || separator === -1) {
      continue;
    }
    headers[trimmed.slice(0, separator).trim()] = trimmed
      .slice(separator + 1)
      .trim();
  }
  return headers;
};

/** Identity of the exporting service, attached to every exported signal. */
export interface OtlpOptions {
  readonly attributes?: Record<string, unknown>;
  readonly serviceName: string;
  /**
   * Overrides the build read from `SERVICE_VERSION`. Leave unset: the default
   * is the same value the ledger stamps as `version`.
   */
  readonly serviceVersion?: string;
}

/**
 * OTLP forwarder — config-gated, off by default.
 *
 * The JSONL ledger is the load-bearing sink; this one is additive. When
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set, logs, metrics and traces are exported
 * there over OTLP/JSON, so the wide event reaches a backend as the same
 * annotated record it wrote to disk. When the endpoint is unset the layer is
 * `Layer.empty`: no HTTP client is constructed and no network call is made.
 *
 * Credentials ride `OTEL_EXPORTER_OTLP_HEADERS` only, never code. Build this
 * over the console logger layer — the OTLP logger merges with the loggers
 * present in its own build scope.
 */
export const otlpLayer = (options: OtlpOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const endpoint = yield* Config.option(
        Config.string("OTEL_EXPORTER_OTLP_ENDPOINT")
      );
      const headers = yield* Config.option(
        Config.string("OTEL_EXPORTER_OTLP_HEADERS")
      );
      // Read here rather than taken from the caller, so `service.version` on the
      // exported resource and `version` on the ledger row are the same fact and
      // no application has to remember to pass it.
      const serviceVersion =
        options.serviceVersion ?? (yield* serviceVersionConfig);
      return Option.match(endpoint, {
        onNone: () => Layer.empty,
        onSome: (baseUrl) =>
          Otlp.layerJson({
            baseUrl,
            headers: Option.getOrUndefined(
              Option.map(headers, parseOtlpHeaders)
            ),
            resource: {
              attributes: options.attributes,
              serviceName: options.serviceName,
              serviceVersion,
            },
          }).pipe(Layer.provide(FetchHttpClient.layer)),
      });
    })
  );
