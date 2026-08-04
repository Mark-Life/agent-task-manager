/**
 * Voice notes become text here, and nowhere else.
 *
 * Groq's Whisper endpoint is the only speech-to-text this process knows about,
 * and the key that reaches it is optional on purpose: a bot with no
 * `GROQ_API_KEY` still serves every text command, and a voice note gets a
 * refusal a person can read rather than a boot that never happened. That is why
 * absence is a typed failure of the call and not a failure of the layer.
 *
 * The transcript is content. It leaves this module as a string for the prompt
 * and the message row, and as a character count plus a millisecond duration for
 * the ledger — the duration is measured around the whole call, network
 * included, because that is what a person waiting for a reply experiences.
 */

import {
  Config,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import Groq from "groq-sdk";

/** How long one transcription may take before it is abandoned. */
const TRANSCRIBE_TIMEOUT = Duration.seconds(60);

/** The Whisper variant: fastest of the hosted models, accurate enough for a voice note. */
const MODEL = "whisper-large-v3-turbo";

/** Telegram sends voice notes as OGG/Opus, always. */
const AUDIO_MIME_TYPE = "audio/ogg";

/** The variable holding the Groq key. Optional: see the module comment. */
export const GROQ_API_KEY_ENV_VAR = "GROQ_API_KEY";

/** The key, or `None` when this install has no speech-to-text. */
export const groqApiKeyConfig = Config.option(
  Config.redacted(GROQ_API_KEY_ENV_VAR)
);

/**
 * The transcription itself failed: network, a refusal from Groq, a decode, or
 * the timeout. `detail` is a message for a person, never the audio.
 */
export class TranscriptionFailed extends Schema.TaggedErrorClass<TranscriptionFailed>()(
  "Transcribe.Failed",
  { detail: Schema.String }
) {
  override get message() {
    return `transcription failed — ${this.detail}`;
  }
}

/**
 * There is no `GROQ_API_KEY`, so this install cannot hear. A failure of the
 * call rather than of the layer, so the rest of the bot works untouched.
 */
export class TranscriptionUnavailable extends Schema.TaggedErrorClass<TranscriptionUnavailable>()(
  "Transcribe.Unavailable",
  {}
) {
  override get message() {
    return `transcription is not configured — set ${GROQ_API_KEY_ENV_VAR}`;
  }
}

/** The Groq surface this module actually calls, and the seam a test drives. */
export type Transcriber = Pick<Groq, "audio">;

/**
 * One voice note, in bytes, with the name Groq sees. The view is over its own
 * `ArrayBuffer` because that is what an upload body accepts — a shared or
 * resizable buffer would have to be copied here anyway.
 */
export interface TranscribeInput {
  readonly audio: Uint8Array<ArrayBuffer>;
  readonly filename: string;
}

/**
 * What one transcription produced. The text is for the prompt and the message
 * row; `chars` and `durationMs` are what an event may carry.
 */
export interface Transcript {
  readonly chars: number;
  readonly durationMs: number;
  readonly text: string;
}

/** Any thrown shape, named without carrying the audio or the request URL. */
const failure = (cause: unknown) =>
  new TranscriptionFailed({
    detail: cause instanceof Error ? cause.message : String(cause),
  });

/**
 * One timeout-bounded Groq Whisper transcription, timed and tagged. Pure over
 * the client, so a fake transcriber drives it in a test with no network.
 *
 * Telegram caps a bot's file download at 20MB, which is under Groq's
 * single-request limit, so a voice note is always one call with no chunking.
 */
export const transcribeWith = Effect.fn("transcribe.audio")(function* (
  client: Transcriber,
  input: TranscribeInput,
  timeout: Duration.Duration = TRANSCRIBE_TIMEOUT
) {
  const [elapsed, response] = yield* Effect.tryPromise({
    catch: failure,
    try: () =>
      client.audio.transcriptions.create({
        file: new File([input.audio], input.filename, {
          type: AUDIO_MIME_TYPE,
        }),
        model: MODEL,
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          failure(
            new Error(
              `Groq transcription exceeded ${Duration.toSeconds(timeout)}s`
            )
          )
        ),
    }),
    Effect.timed
  );

  const durationMs = Duration.toMillis(elapsed);
  // Only the shape of the transcript reaches the span. The words do not.
  yield* Effect.annotateCurrentSpan({
    chars: response.text.length,
    durationMs,
  });
  return {
    chars: response.text.length,
    durationMs,
    text: response.text,
  } satisfies Transcript;
});

const make = Effect.gen(function* () {
  const apiKey = yield* groqApiKeyConfig;

  // Built once in the layer scope, from the configured key rather than ambient
  // env, so a process with no key holds no client at all and cannot pretend.
  const client = Option.map(
    apiKey,
    (key): Transcriber => new Groq({ apiKey: Redacted.value(key) })
  );

  const transcribe = (input: TranscribeInput) =>
    Option.match(client, {
      onNone: () => Effect.fail(new TranscriptionUnavailable()),
      onSome: (groq) => transcribeWith(groq, input),
    });

  /** Whether this process can transcribe at all — for `/status` and for a refusal. */
  const available = Option.isSome(client);

  return { available, transcribe } as const;
});

/**
 * Speech-to-text as a service: the key read once at layer build, a tagged
 * failure on both the refusal and the absence, a span per call, and a duration
 * every caller gets without having to remember to measure it.
 */
export class TranscribeService extends Context.Service<
  TranscribeService,
  Effect.Success<typeof make>
>()("bot/TranscribeService") {
  static readonly layer = Layer.effect(TranscribeService, make);
}
