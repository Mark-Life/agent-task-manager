/**
 * What an outbound Telegram call can fail with, as one typed error.
 *
 * grammy throws two unrelated shapes — `GrammyError` when Telegram answered and
 * said no, `HttpError` when the request never got an answer — and neither is a
 * value this codebase can put on a wide event. This flattens both into a tagged
 * error whose fields are the ones that decide what a caller does next:
 * `errorCode` tells a 429 from a 400, `method` says which call it was, and
 * `description` is Telegram's own sentence, which is the only place a reason
 * like "message is not modified" ever appears.
 *
 * `cause` is kept unknown and is never logged directly. The Telegram file API
 * puts the bot token in the URL, so a raw cause can carry the token; every path
 * out of here goes through the telemetry package's sanitizer, which redacts
 * exactly that shape.
 */

import { Schema } from "effect";
import { GrammyError, HttpError } from "grammy";

/** Telegram's own code for "you are going too fast". */
const TOO_MANY_REQUESTS = 429;

/** The lowest code that means Telegram's side broke, not ours. */
const SERVER_ERROR_FLOOR = 500;

/** An outbound Telegram API call that did not succeed. */
export class TelegramApiError extends Schema.TaggedErrorClass<TelegramApiError>()(
  "Telegram.ApiError",
  {
    cause: Schema.Unknown,
    /** Telegram's sentence, or the transport failure's message. */
    description: Schema.String,
    /** Telegram's numeric code; null when the request never reached it. */
    errorCode: Schema.NullOr(Schema.Int),
    /** The Bot API method that failed, for the row and for the log. */
    method: Schema.String,
    /** Seconds Telegram asked us to wait, on a 429 that said so. */
    retryAfterSeconds: Schema.NullOr(Schema.Int),
  }
) {
  override get message() {
    return `${this.method} — ${this.description}`;
  }
}

/**
 * Turn whatever grammy threw into the one error type this app carries.
 *
 * The unknown branch is not dead code: an SDK defect, an aborted fetch and a
 * `TypeError` from a bad argument all land there, and swallowing them into a
 * generic "network error" is how a programming mistake gets read as an outage.
 */
export const toTelegramApiError = (options: {
  readonly cause: unknown;
  readonly method: string;
}) => {
  const { cause, method } = options;
  if (cause instanceof GrammyError) {
    return new TelegramApiError({
      cause,
      description: cause.description,
      errorCode: cause.error_code,
      method,
      retryAfterSeconds:
        cause.error_code === TOO_MANY_REQUESTS
          ? (cause.parameters.retry_after ?? null)
          : null,
    });
  }
  if (cause instanceof HttpError) {
    return new TelegramApiError({
      cause,
      description: cause.message,
      errorCode: null,
      method,
      retryAfterSeconds: null,
    });
  }
  return new TelegramApiError({
    cause,
    description: cause instanceof Error ? cause.message : String(cause),
    errorCode: null,
    method,
    retryAfterSeconds: null,
  });
};

/**
 * Whether the same call is worth making again.
 *
 * A 429 is, once the wait is over. A 5xx is, because Telegram's own gateway
 * fails intermittently. A transport failure is. A 400 never is — the request
 * was wrong, and retrying it is a loop that ends when the process does.
 */
export const isRetriable = (error: TelegramApiError) =>
  error.errorCode === null ||
  error.errorCode === TOO_MANY_REQUESTS ||
  error.errorCode >= SERVER_ERROR_FLOOR;
