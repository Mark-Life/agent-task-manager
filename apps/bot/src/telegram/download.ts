/**
 * The one place a Telegram file URL is built, because that URL contains the bot
 * token.
 *
 * `https://api.telegram.org/file/bot<token>/<path>` is not a grammy call — it
 * is a bare `fetch` — and every place that spelled it out by hand is a place a
 * thrown error, a log line or a stack trace could carry the token off the host.
 * Keeping it here means the token arrives as `Redacted`, is unwrapped for the
 * length of one request, and every failure that escapes has been through
 * {@link clipError}, whose secret patterns include the Telegram bot-token shape.
 *
 * Telegram refuses to serve a bot a file over 20MB, so the whole body is read
 * into memory deliberately: streaming would buy nothing against a bound the API
 * already enforces.
 */

import { clipError } from "@workspace/telemetry";
import { Effect, Redacted, Schema } from "effect";

/** The Bot API host. Named once so a self-hosted API server is a one-line change. */
const TELEGRAM_API_ORIGIN = "https://api.telegram.org";

/** The grammy surface a download needs, and the seam a test drives. */
export interface FileLocator {
  readonly getFile: (fileId: string) => Promise<{
    readonly file_path?: string | undefined;
  }>;
}

/**
 * Telegram would not hand over the file: the id expired, the file is too large
 * for a bot to fetch, or the request failed. `detail` is sanitized, so a URL
 * carrying the token cannot ride out on it.
 */
export class FileDownloadFailed extends Schema.TaggedErrorClass<FileDownloadFailed>()(
  "Telegram.FileDownloadFailed",
  { detail: Schema.String }
) {
  override get message() {
    return `telegram file download failed — ${this.detail}`;
  }
}

const downloadFailure = (cause: unknown) =>
  new FileDownloadFailed({
    detail: clipError(cause instanceof Error ? cause.message : String(cause)),
  });

/**
 * The download URL for a file path. Exported for one reason — so a reader
 * grepping for the token's other spellings finds none — and it takes the token
 * as `Redacted` so producing the string is a deliberate act.
 */
export const telegramFileUrl = (options: {
  readonly filePath: string;
  readonly token: Redacted.Redacted;
}) =>
  `${TELEGRAM_API_ORIGIN}/file/bot${Redacted.value(options.token)}/${options.filePath}`;

/**
 * Resolves a Telegram file id to its bytes.
 *
 * Two round trips, both of which can fail for reasons a person can act on, and
 * both of which are folded into one tagged error: `getFile` names the path, the
 * `fetch` retrieves it. The bytes come back as a `Uint8Array` because that is
 * what a `File` for an upload wants and what a hash wants; nothing here decodes
 * them.
 */
export const downloadTelegramFile = Effect.fn("telegram.downloadFile")(
  function* (options: {
    readonly api: FileLocator;
    readonly fileId: string;
    readonly token: Redacted.Redacted;
  }) {
    const file = yield* Effect.tryPromise({
      catch: downloadFailure,
      try: () => options.api.getFile(options.fileId),
    });

    const filePath = file.file_path;
    if (filePath === undefined) {
      return yield* new FileDownloadFailed({
        detail: "telegram returned no file path for the file id",
      });
    }

    const bytes = yield* Effect.tryPromise({
      catch: downloadFailure,
      try: async () => {
        const response = await fetch(
          telegramFileUrl({ filePath, token: options.token })
        );
        if (!response.ok) {
          // The status, never the URL: the URL is the token.
          throw new Error(`telegram file request answered ${response.status}`);
        }
        return new Uint8Array(await response.arrayBuffer());
      },
    });

    yield* Effect.annotateCurrentSpan({ bytes: bytes.byteLength });
    return bytes;
  }
);
