/**
 * Test design (testing-strategy): the one retry's tables (review of #217; they replace the
 * `retryWaitMs` and `isRetryableStatus` tables of the Zhipu search provider's tests, deleted with it)
 *
 * SUT: retryWaitMs and isRetryableStatus, pure; isQuotaError, pure.
 *
 * Oracle: OpenAI's rate-limit guide as design.md records it (D3, "Rate limits"): a 429 with
 *   `Retry-After`; quota errors are not retried; and the project's rule that the wait is capped
 *   (the call's budget is the caller's) and that an absent or unusable header falls back.
 *
 * Cells
 *   Retry-After | absent / empty / blank       | fallback 2 s
 *   Retry-After | "3", " 4 ", "0", "1.5"       | seconds, as milliseconds
 *   Retry-After | "600"                        | capped at 10 s
 *   Retry-After | "soon", "-5", "NaN", HTTP date | fallback (a date is not seconds, and is unusable here)
 *   status      | 429, 500, 502, 503, 599        | retryable
 *   status      | 200, 400, 401, 403, 404, 422   | not retryable: a request this code got wrong is not repeated
 *   quota body  | insufficient_quota             | detected; a plain rate-limit body is not
 */
import { describe, expect, it } from "vitest";
import { isQuotaError, isRetryableStatus, OPENAI_RETRY_FALLBACK_MS, OPENAI_RETRY_MAX_WAIT_MS, retryWaitMs } from "./openai-retry.js";

describe("retryWaitMs", () => {
  it("keeps the documented bounds: a 2 s fallback and a 10 s cap", () => {
    expect(OPENAI_RETRY_FALLBACK_MS).toBe(2_000);
    expect(OPENAI_RETRY_MAX_WAIT_MS).toBe(10_000);
  });

  it.each([
    [null, OPENAI_RETRY_FALLBACK_MS],
    ["", OPENAI_RETRY_FALLBACK_MS],
    ["   ", OPENAI_RETRY_FALLBACK_MS],
    ["3", 3_000],
    [" 4 ", 4_000],
    ["0", 0],
    ["1.5", 1_500],
    ["600", OPENAI_RETRY_MAX_WAIT_MS],
    ["10", OPENAI_RETRY_MAX_WAIT_MS],
    ["soon", OPENAI_RETRY_FALLBACK_MS],
    ["-5", OPENAI_RETRY_FALLBACK_MS],
    ["NaN", OPENAI_RETRY_FALLBACK_MS],
    ["Infinity", OPENAI_RETRY_FALLBACK_MS],
    ["Wed, 21 Oct 2026 07:28:00 GMT", OPENAI_RETRY_FALLBACK_MS],
  ])("Retry-After %j waits %ims", (header, expected) => {
    expect(retryWaitMs(header)).toBe(expected);
  });
});

describe("isRetryableStatus", () => {
  it.each([
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [599, true],
    [200, false],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [422, false],
  ])("status %i retryable: %s", (status, expected) => {
    expect(isRetryableStatus(status)).toBe(expected);
  });
});

describe("isQuotaError", () => {
  it("recognises a spent quota and nothing else", () => {
    expect(isQuotaError('{"error":{"code":"insufficient_quota","type":"insufficient_quota"}}')).toBe(true);
    expect(isQuotaError('{"error":{"code":"rate_limit_exceeded","type":"requests"}}')).toBe(false);
    expect(isQuotaError("")).toBe(false);
  });
});
