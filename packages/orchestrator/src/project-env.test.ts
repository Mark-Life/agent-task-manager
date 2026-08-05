import { describe, expect, test } from "bun:test";
import type { EnvFilePath, EnvFileWrite } from "@workspace/domain";
import {
  makeRedactor,
  REDACTION_MARKER,
  redactDeep,
  secretValuesOf,
} from "./project-env";

const file = (content: string): EnvFileWrite => ({
  content,
  path: ".env" as EnvFilePath,
});

describe("the values a run's env files assign", () => {
  test("are the right-hand sides, so the key stays readable in a timeline", () => {
    expect(
      secretValuesOf([file("DATABASE_URL=postgres://user:pw@host/db\n")])
    ).toEqual(["postgres://user:pw@host/db"]);
  });

  test("come out of quotes, because that is how the shell reads them", () => {
    expect(secretValuesOf([file('API_KEY="sk-abcdefghijklmnop"')])).toEqual([
      "sk-abcdefghijklmnop",
    ]);
    expect(secretValuesOf([file("API_KEY='sk-abcdefghijklmnop'")])).toEqual([
      "sk-abcdefghijklmnop",
    ]);
  });

  test("survive an `export` prefix", () => {
    expect(
      secretValuesOf([file("export TOKEN=ghp_abcdefghijklmnop\n")])
    ).toEqual(["ghp_abcdefghijklmnop"]);
  });

  test("skip comments, blanks and lines that assign nothing", () => {
    expect(
      secretValuesOf([
        file("# a comment about SUPER_SECRET_VALUE\n\nnot-an-assignment\n"),
      ])
    ).toEqual([]);
  });

  // A short value is a flag or a port. Replacing every occurrence of it would
  // scrub an ordinary word out of every log line the run produced.
  test("skip anything too short to be a secret", () => {
    expect(secretValuesOf([file("NODE_ENV=test\nPORT=3000\n")])).toEqual([]);
  });

  test("are deduplicated across files and sorted longest first", () => {
    const values = secretValuesOf([
      file("A=https://api.example.com\n"),
      file("B=https://api.example.com/v1/secret\nC=https://api.example.com\n"),
    ]);
    expect(values).toEqual([
      "https://api.example.com/v1/secret",
      "https://api.example.com",
    ]);
  });
});

describe("redacting what a run said", () => {
  const redact = makeRedactor(
    secretValuesOf([
      file(
        "DATABASE_URL=postgres://user:pw@host/db\nAPI_BASE=https://api.example.com\nAPI_URL=https://api.example.com/v1/secret\n"
      ),
    ])
  );

  test("replaces a value the agent printed", () => {
    const said = redact("$ cat .env\nDATABASE_URL=postgres://user:pw@host/db");
    expect(said).toBe(`$ cat .env\nDATABASE_URL=${REDACTION_MARKER}`);
    expect(said).not.toContain("user:pw");
  });

  test("replaces every occurrence, not the first", () => {
    expect(
      redact("postgres://user:pw@host/db and postgres://user:pw@host/db")
    ).toBe(`${REDACTION_MARKER} and ${REDACTION_MARKER}`);
  });

  // The longer value is replaced first, so its tail cannot be left sitting
  // beside a marker and read as though it had been hidden.
  test("leaves no tail of a longer value that shares a prefix", () => {
    const said = redact("GET https://api.example.com/v1/secret");
    expect(said).toBe(`GET ${REDACTION_MARKER}`);
    expect(said).not.toContain("/v1/secret");
  });

  test("costs nothing for a run with no env files", () => {
    const none = makeRedactor([]);
    expect(none("postgres://user:pw@host/db")).toBe(
      "postgres://user:pw@host/db"
    );
  });
});

describe("redacting a whole event", () => {
  const redact = makeRedactor(secretValuesOf([file("KEY=sk-abcdefghijkl\n")]));

  test("reaches every string, however deeply nested", () => {
    const event = {
      chars: 42,
      kind: "tool_result",
      nested: { list: ["sk-abcdefghijkl", 7, null] },
      ok: true,
      summary: "the key is sk-abcdefghijkl",
    };
    expect(redactDeep(event, redact)).toEqual({
      chars: 42,
      kind: "tool_result",
      nested: { list: [REDACTION_MARKER, 7, null] },
      ok: true,
      summary: `the key is ${REDACTION_MARKER}`,
    });
  });

  test("leaves numbers, booleans and nulls as they are", () => {
    expect(redactDeep({ a: 1, b: false, c: null }, redact)).toEqual({
      a: 1,
      b: false,
      c: null,
    });
  });
});
