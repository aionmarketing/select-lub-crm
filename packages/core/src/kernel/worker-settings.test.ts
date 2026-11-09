/**
 * Test design (testing-strategy) — the worker's manual-ingestion settings
 *
 * SUT: resolveWorkerSettings, with an injected env.
 *
 * Oracle: ingest-harvested-manuals PR 2 — manual ingestion is ON unless
 *   `MANUAL_INGESTION_ENABLED=false` (the owner approved background ingestion; this is its kill
 *   switch), and its interval is `WORKER_MANUAL_INGEST_MS`, 60 s when unset or not a positive
 *   number. An explicit option beats the env, as for every other setting.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveWorkerSettings } from "./worker-settings.js";

describe("resolveWorkerSettings — manual ingestion", () => {
  it("is on by default, every 60 s", () => {
    expect(resolveWorkerSettings({}, {})).toMatchObject({ manualIngestion: true, manualIngestMs: 60_000 });
  });

  it("is switched off only by an explicit false", () => {
    expect(resolveWorkerSettings({}, { MANUAL_INGESTION_ENABLED: "false" }).manualIngestion).toBe(false);
    expect(resolveWorkerSettings({}, { MANUAL_INGESTION_ENABLED: "0" }).manualIngestion).toBe(true);
    expect(resolveWorkerSettings({}, { MANUAL_INGESTION_ENABLED: "true" }).manualIngestion).toBe(true);
  });

  it.each([
    ["300000", 300_000],
    ["0", 60_000],
    ["-5", 60_000],
    ["soon", 60_000],
  ])("reads WORKER_MANUAL_INGEST_MS=%s as %i", (value, expected) => {
    expect(resolveWorkerSettings({}, { WORKER_MANUAL_INGEST_MS: value }).manualIngestMs).toBe(expected);
  });

  it("lets an explicit option beat the env", () => {
    expect(resolveWorkerSettings({ manualIngestion: true }, { MANUAL_INGESTION_ENABLED: "false" }).manualIngestion).toBe(true);
  });
});

/*
 * Oracle: background-oil-research D3, D9, D21 (task 3.8) — research is on only for exactly
 * `OIL_RESEARCH_ENABLED=true`; each setting falls back to its default on anything unusable; the
 * daily budget parses strictly (a number ≥ 0 with a dot), is reported when mistyped, and 0 is a
 * valid budget; the run ceiling is left to the effort row (null) unless set.
 */
describe("resolveWorkerSettings — oil research", () => {
  it("is off unless OIL_RESEARCH_ENABLED is exactly true", () => {
    expect(resolveWorkerSettings({}, {}).oilResearch).toBe(false);
    for (const value of ["1", "TRUE", "yes", " true", ""]) {
      expect(resolveWorkerSettings({}, { OIL_RESEARCH_ENABLED: value }).oilResearch).toBe(false);
    }
    expect(resolveWorkerSettings({}, { OIL_RESEARCH_ENABLED: "true" }).oilResearch).toBe(true);
    expect(resolveWorkerSettings({ oilResearch: false }, { OIL_RESEARCH_ENABLED: "true" }).oilResearch).toBe(false);
  });

  it("has D7–D13's defaults", () => {
    expect(resolveWorkerSettings({}, {})).toMatchObject({
      oilResearchTickMs: 10_000,
      oilResearchSweepMs: 60_000,
      oilResearchSettleMs: 120_000,
      oilResearchBackfillPaceMs: 60_000,
      oilResearchManualWaitMs: 30 * 60_000,
      oilResearchRunTimeoutMs: null,
      oilResearchProviderPauseMs: 15 * 60_000,
      oilResearchOutageBreaker: 3,
      oilResearchMaxAttempts: 3,
      oilResearchDailyBudgetUsd: 2,
    });
  });

  it("reads each setting from the env, and falls back on an unusable value", () => {
    const set = resolveWorkerSettings({}, {
      OIL_RESEARCH_TICK_MS: "5000",
      OIL_RESEARCH_SETTLE_MS: "0",
      OIL_RESEARCH_RUN_TIMEOUT_MS: "5400000",
      OIL_RESEARCH_OUTAGE_BREAKER: "5",
      OIL_RESEARCH_BACKFILL_PACE_MS: "-1",
      OIL_RESEARCH_PROVIDER_PAUSE_MS: "soon",
    });
    expect(set).toMatchObject({
      oilResearchTickMs: 5_000,
      oilResearchSettleMs: 0,
      oilResearchRunTimeoutMs: 5_400_000,
      oilResearchOutageBreaker: 5,
      oilResearchBackfillPaceMs: 60_000,
      oilResearchProviderPauseMs: 15 * 60_000,
    });
    expect(resolveWorkerSettings({}, { OIL_RESEARCH_RUN_TIMEOUT_MS: "later" }).oilResearchRunTimeoutMs).toBeNull();
  });

  it("reads MOTUL_DEGRADED_AFTER_MS, and keeps six hours for an unusable value", () => {
    expect(resolveWorkerSettings({}, { MOTUL_DEGRADED_AFTER_MS: "3600000" }).motulDegradedAfterMs).toBe(3_600_000);
    for (const value of ["0", "-5", "soon", ""]) {
      expect(resolveWorkerSettings({}, { MOTUL_DEGRADED_AFTER_MS: value }).motulDegradedAfterMs).toBe(6 * 60 * 60_000);
    }
  });

  it.each(["0.5", "0", "-1", "2.7", "many"])("refuses %j as the breaker or the attempts, keeping 3", (value) => {
    const set = resolveWorkerSettings({}, { OIL_RESEARCH_OUTAGE_BREAKER: value, OIL_RESEARCH_MAX_ATTEMPTS: value });
    expect(set).toMatchObject({ oilResearchOutageBreaker: 3, oilResearchMaxAttempts: 3 });
  });

  it.each([
    ["0.50", 0.5],
    ["0", 0],
    ["3", 3],
  ])("reads the budget %s as %d", (value, expected) => {
    expect(resolveWorkerSettings({}, { OIL_RESEARCH_DAILY_BUDGET_USD: value }).oilResearchDailyBudgetUsd).toBe(expected);
  });

  it.each(["1,00", "abc", "-1", "", "NaN"])("reports the mistyped budget %j and uses 2.00", (value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(resolveWorkerSettings({}, { OIL_RESEARCH_DAILY_BUDGET_USD: value }).oilResearchDailyBudgetUsd).toBe(2);
      expect(warn).toHaveBeenCalledWith("money-setting", expect.stringContaining("OIL_RESEARCH_DAILY_BUDGET_USD"));
    } finally {
      warn.mockRestore();
    }
  });
});
