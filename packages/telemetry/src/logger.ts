import { Config, Effect, Layer, Logger, References } from "effect";

/** The console encodings a service can be asked for. */
export const LOG_FORMATS = ["pretty", "logfmt", "json"] as const;

/** One of {@link LOG_FORMATS}. */
export type LogFormat = (typeof LOG_FORMATS)[number];

/**
 * `LOG_FORMAT` selects the console encoding: `pretty` for a human at a
 * terminal, `logfmt` for a journal, `json` for a collector. Defaults to
 * `pretty` on a TTY and `logfmt` everywhere else.
 */
const logFormatConfig = Config.literals(LOG_FORMATS, "LOG_FORMAT").pipe(
  Config.withDefault(process.stdout.isTTY ? "pretty" : "logfmt")
);

/**
 * `LOG_LEVEL` is the minimum severity a narration line needs to be printed.
 * Accepts any Effect log level: All|Fatal|Error|Warn|Info|Debug|Trace|None.
 * The wide event is emitted above this floor and is unaffected.
 */
const logLevelConfig = Config.logLevel("LOG_LEVEL").pipe(
  Config.withDefault("Info")
);

/**
 * Resolves the console logger matching a format. `consoleJson` and
 * `consoleLogFmt` are values; `consolePretty` is a factory.
 */
const consoleLoggerFor = (format: LogFormat) => {
  switch (format) {
    case "json":
      return Logger.consoleJson;
    case "logfmt":
      return Logger.consoleLogFmt;
    default:
      return Logger.consolePretty();
  }
};

/**
 * The sole console sink. `Logger.layer` replaces the runtime's default logger
 * rather than adding a second, so a line is printed exactly once, and installs
 * the minimum level alongside it.
 */
export const loggerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const format = yield* logFormatConfig;
    const level = yield* logLevelConfig;
    return Layer.mergeAll(
      Logger.layer([consoleLoggerFor(format)]),
      Layer.succeed(References.MinimumLogLevel, level)
    );
  })
);
