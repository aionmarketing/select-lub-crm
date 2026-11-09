/**
 * Test design (testing-strategy) — the reading lease follows the call ceiling (task 1.9)
 *
 * SUT: readingLeaseMs, pure: no database, no model.
 *
 * Oracle: design.md D2 ("The leases follow") and D20, with OpenAI's limits (switch-oil-research-to-openai
 *   D6): the reading lease is `3 × OIL_RESEARCH_CALL_TIMEOUT_MS + 60 s` — one selector call and an
 *   extraction with its retry, each up to the call ceiling — 13 min on `gpt-6.1-sol` at `medium`
 *   (240 s a call); it moves with an explicit OIL_RESEARCH_CALL_TIMEOUT_MS. An effort or a model
 *   with no measured row runs on the placeholder row, which has the same 240 s ceiling.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readingLeaseMs } from "../index.js";

afterEach(() => {
  delete process.env.OIL_RESEARCH_REASONING_EFFORT;
  delete process.env.OIL_RESEARCH_MODEL;
  delete process.env.OIL_RESEARCH_CALL_TIMEOUT_MS;
});

describe("readingLeaseMs", () => {
  it("is 13 minutes by default", () => {
    expect(readingLeaseMs()).toBe(13 * 60_000);
  });

  it("is 13 minutes at an effort with no measured row: the placeholder row's ceiling", () => {
    process.env.OIL_RESEARCH_REASONING_EFFORT = "high";

    expect(readingLeaseMs()).toBe(13 * 60_000);
  });

  it("is 13 minutes for a model with no measured row", () => {
    process.env.OIL_RESEARCH_MODEL = "gpt-9-unlisted";

    expect(readingLeaseMs()).toBe(13 * 60_000);
  });

  it("follows an explicit OIL_RESEARCH_CALL_TIMEOUT_MS", () => {
    process.env.OIL_RESEARCH_CALL_TIMEOUT_MS = "100000";

    expect(readingLeaseMs()).toBe(360_000);
  });
});
