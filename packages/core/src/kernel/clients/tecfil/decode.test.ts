/**
 * Test design (testing-strategy)
 *
 * Setup: `decodeTecfilBody` is pure string/JSON handling, no HTTP. The happy
 * path uses a body recorded from the live Catálogo Expresso API on
 * 2026-09-04 (`fixtures/raw-obfuscated-body.txt`) so the test exercises the
 * real rotation offsets and block boundaries, not a hand-built stand-in.
 *
 * Spec: openspec/changes/tecfil-filter-pricing/specs/tecfil-fitment/spec.md
 * — "Wire encoding and decoding stay inside the package" (recorded body
 * decodes to recorded JSON; unwrapped error body surfaces as a failure
 * without the rotation decode).
 *
 * Techniques: EP of body shape (obfuscated envelope | unwrapped `{`/`[` JSON
 * | malformed obfuscated envelope | malformed unwrapped JSON); one golden
 * fixture for the happy path instead of BVA (the rotation offsets are
 * recorded data, not a boundary to sweep).
 *
 * Axes
 * A1 body shape: obfuscated (3-part envelope) | unwrapped object | unwrapped
 *    array | malformed (wrong part count) | unwrapped but invalid JSON
 *
 * Outputs: O1 decoded JSON equals the recorded value; O2 unwrapped JSON
 * returned as-is, no rotation attempted; O3 throws TecfilDecodeError
 *
 * Sampled-cell table
 * it                                                | axis         | O | fails if
 * decodes the recorded body to the recorded JSON     | A1 obfuscated| 1 | any field differs from the recording
 * passes an unwrapped object body through untouched  | A1 object    | 2 | value differs, or throws
 * passes an unwrapped array body through untouched   | A1 array     | 2 | value differs, or throws
 * surfaces a malformed obfuscated envelope as a failure without decoding
 *                                                    | A1 malformed | 3 | does not throw, or throws before checking the `{`/`[` shortcut
 * surfaces invalid unwrapped JSON as a failure       | A1 invalid   | 3 | does not throw
 *
 * One-sided decisions (repo-foundation:114), added 2026-09-07
 *
 * `decodeTecfilBody` has four `catch` arms. Two are now sampled, each asserting
 * the MESSAGE and not merely the error type, because every failure throws the
 * same `TecfilDecodeError` and the message is the only thing naming which of a
 * two-stage decode gave way:
 *   - "rotation offset arrays are not valid JSON" (decode.ts:80)
 *   - "decoded body is not valid JSON" (decode.ts:99)
 *
 * The other two are UNREACHABLE — dead code, reported 2026-09-07:
 *   - decode.ts:61 "outer base64 decode failed"
 *   - decode.ts:91 "inner base64 decode failed"
 * Node's `Buffer.from(s, "base64")` does not throw on malformed input; it
 * silently ignores characters outside the alphabet. Probed directly: "!!!",
 * "@@@@", "a" and "" all return a zero-length buffer and "####not base64####"
 * returns six bytes of garbage, none of them throwing, and `.toString("utf8")`
 * does not throw either. So neither catch can execute and neither message can
 * ever reach an operator.
 *
 * The consequence is diagnostic rather than behavioural — `tecfil-fitment`'s
 * resolver requirement maps any decode failure to `unavailable`, so the caller
 * sees the same outcome. But a genuinely corrupt body reports whichever LATER
 * stage happens to fail, pointing at the wrong half of the decode. Left in
 * place: a tests-only change does not delete production code, and the fix
 * carries a design question (add an explicit base64 validity check, or reword
 * the later errors to admit an upstream cause).
 *
 * Out of scope: live HTTP fetch (that's client.ts); the `/catweb/v2/getpol.asp`
 * host, which is never wrapped and is not called through this module.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeTecfilBody, TecfilDecodeError } from "./decode.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "./fixtures");

describe("decodeTecfilBody", () => {
  it("decodes the recorded body to the recorded JSON", () => {
    const raw = readFileSync(join(fixturesDir, "raw-obfuscated-body.txt"), "utf8");
    const expected = JSON.parse(
      readFileSync(join(fixturesDir, "raw-obfuscated-body.decoded.json"), "utf8"),
    );

    expect(decodeTecfilBody(raw)).toEqual(expected);
  });

  it("passes an unwrapped object body through untouched", () => {
    const body = JSON.stringify({
      message: "Token reCAPTCHA não fornecido",
      error: "Bad Request",
      statusCode: 400,
    });

    expect(decodeTecfilBody(body)).toEqual({
      message: "Token reCAPTCHA não fornecido",
      error: "Bad Request",
      statusCode: 400,
    });
  });

  it("passes an unwrapped array body through untouched", () => {
    expect(decodeTecfilBody("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("surfaces a malformed obfuscated envelope as a failure without decoding", () => {
    const notThreeParts = Buffer.from("only-one-part", "utf8").toString("base64");

    expect(() => decodeTecfilBody(notThreeParts)).toThrow(TecfilDecodeError);
  });

  it("surfaces invalid unwrapped JSON as a failure", () => {
    expect(() => decodeTecfilBody("{not valid json")).toThrow(TecfilDecodeError);
  });

  /** A three-part obfuscated envelope, base64-wrapped the way Tecfil sends it. */
  const envelope = (offsets0: string, scrambled: string, offsets2: string) =>
    Buffer.from([offsets0, scrambled, offsets2].join("<!1!>"), "utf8").toString("base64");

  it("names the rotation offsets when they are not valid JSON", () => {
    // The envelope splits into exactly three parts, so it gets past the part
    // count and dies on the offset arrays instead. Distinguishing the two is
    // the point: both are "malformed envelope" to a caller, and only the
    // message says which stage failed.
    const body = envelope("notjson", "cGF5bG9hZA==", "[]");

    expect(() => decodeTecfilBody(body)).toThrow(TecfilDecodeError);
    expect(() => decodeTecfilBody(body)).toThrow(/rotation offset arrays are not valid JSON/);
  });

  it("names the decoded body when the inner payload is not JSON", () => {
    // Empty offset arrays make both rotations the identity, so the inner
    // base64 is decoded verbatim — which isolates the LAST failure stage from
    // the rotation entirely.
    const inner = Buffer.from("not json at all", "utf8").toString("base64");
    const body = envelope("[]", inner, "[]");

    expect(() => decodeTecfilBody(body)).toThrow(TecfilDecodeError);
    expect(() => decodeTecfilBody(body)).toThrow(/decoded body is not valid JSON/);
  });
});
