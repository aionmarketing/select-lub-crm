/**
 * Test design (testing-strategy)
 *
 * SUT: `retryIsMoot`, whether a retry job has been overtaken. Pure; no database.
 *
 * Oracle: owner rulings 2026-09-25, PR 4 (review of #168) — a retry is
 *   "extract now": it runs whatever arrived since, and is skipped only when a
 *   NEWER window has been extracted successfully (the stored watermark is past
 *   the failed window AND a job on a later window succeeded).
 *
 * The end-to-end behaviour is in packages/core/test/prefill-retry.test.ts.
 */
import { describe, expect, it } from "vitest";
import { retryIsMoot } from "../index.js";

const W = new Date("2026-09-20T12:00:20.000Z");
const later = new Date(W.getTime() + 60_000);

describe("retryIsMoot", () => {
  it("runs the retry while the watermark is the failed window's, or unset", () => {
    expect(retryIsMoot(W, W, false)).toBe(false);
    expect(retryIsMoot(null, W, false)).toBe(false);
  });

  it("runs the retry when a newer window closed but did not succeed", () => {
    expect(retryIsMoot(later, W, false)).toBe(false);
  });

  it("skips the retry once a newer window has been extracted successfully", () => {
    expect(retryIsMoot(later, W, true)).toBe(true);
  });
});
