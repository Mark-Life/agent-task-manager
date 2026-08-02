/**
 * Two claims worth holding here. That a transcription reports its own length
 * and its own duration, so no caller has to time it and none of them has a
 * reason to keep the words. And that a slow Groq is a tagged failure rather
 * than a handler that waits forever behind a person watching a chat.
 */

import { describe, expect, test } from "bun:test";
import { Duration, Effect } from "effect";
import {
  type Transcriber,
  TranscriptionFailed,
  transcribeWith,
} from "./transcribe";

/** A Groq stand-in that answers after a delay of the test's choosing. */
const transcriberOf = (options: {
  readonly delayMs?: number;
  readonly text: string;
}): Transcriber =>
  ({
    audio: {
      transcriptions: {
        create: () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ text: options.text }),
              options.delayMs ?? 0
            )
          ),
      },
    },
  }) as unknown as Transcriber;

const audio = new Uint8Array([1, 2, 3]);

describe("transcribeWith", () => {
  test("reports the transcript, its character count and how long the call took", async () => {
    const transcript = await Effect.runPromise(
      transcribeWith(transcriberOf({ text: "file a task for me" }), {
        audio,
        filename: "voice.ogg",
      })
    );
    expect(transcript.text).toBe("file a task for me");
    expect(transcript.chars).toBe(18);
    expect(transcript.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("a transcription that outlives its cap fails with a named error", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        transcribeWith(
          transcriberOf({ delayMs: 200, text: "never read" }),
          { audio, filename: "voice.ogg" },
          Duration.millis(10)
        )
      )
    );
    expect(failure).toBeInstanceOf(TranscriptionFailed);
    expect(failure.detail).toContain("exceeded");
  });

  test("a refusal from Groq keeps its message and carries no audio", async () => {
    const failing = {
      audio: {
        transcriptions: {
          create: () => Promise.reject(new Error("401 invalid api key")),
        },
      },
    } as unknown as Transcriber;
    const failure = await Effect.runPromise(
      Effect.flip(transcribeWith(failing, { audio, filename: "voice.ogg" }))
    );
    expect(failure.detail).toBe("401 invalid api key");
  });
});
