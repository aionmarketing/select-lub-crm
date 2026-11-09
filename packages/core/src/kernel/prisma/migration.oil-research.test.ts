/**
 * Test design (testing-strategy)
 *
 * Setup: read migration.sql from disk. No Postgres required; the tables' behaviour runs live in
 *   `packages/core/test/oil-research-store.live.test.ts` on the migrated schema.
 *
 * Oracle: background-oil-research task 2.1 (D7, D9–D14):
 *   - `oil_research` is one row per identity: a unique `identity_key`, and the claim index in
 *     claim order (state, priority, requested_at, queued_at, id);
 *   - its defaults: `queued`, kind `full`, backfill priority 2, attempts 0, `searched` true,
 *     Tecfil attempts 0; the Tecfil claim's own columns (D12);
 *   - every column D7–D14 names, including the pending cycle, the manual wait and the stored
 *     estimate;
 *   - `oil_research_run` carries the timings and the cost, summed by `started_at`;
 *   - `oil_research_runner` is one row, `runner` by default, with the heartbeat, the day, the
 *     spend, the budget, the pause and the watermark;
 *   - nothing existing is altered.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../prisma/migrations/20260926140000_oil_research/migration.sql"),
  "utf8",
);

/** The body of one CREATE TABLE statement, so a column assertion cannot match another table. */
function tableBody(name: string): string {
  const start = sql.indexOf(`CREATE TABLE "${name}"`);
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf(");", start));
}

describe("oil research migration", () => {
  it("keys oil_research by a unique identity_key", () => {
    expect(tableBody("oil_research")).toContain('"identity_key" TEXT NOT NULL');
    expect(sql).toContain('CREATE UNIQUE INDEX "oil_research_identity_key_key" ON "oil_research"("identity_key");');
  });

  it("indexes the claim in claim order", () => {
    expect(sql).toContain('CREATE INDEX "oil_research_claim_idx" ON "oil_research"("state", "priority", "requested_at", "queued_at", "id");');
  });

  it.each([
    `"state" TEXT NOT NULL DEFAULT 'queued'`,
    `"kind" TEXT NOT NULL DEFAULT 'full'`,
    '"priority" INTEGER NOT NULL DEFAULT 2',
    '"attempts" INTEGER NOT NULL DEFAULT 0',
    '"searched" BOOLEAN NOT NULL DEFAULT true',
    '"tecfil_attempts" INTEGER NOT NULL DEFAULT 0',
    '"trigger" TEXT NOT NULL',
    '"queued_at" TIMESTAMPTZ(3) NOT NULL',
    '"cycle_queued_at" TIMESTAMPTZ(3) NOT NULL',
  ])("gives oil_research the default %s", (column) => {
    expect(tableBody("oil_research")).toContain(column);
  });

  it.each([
    "lease_until",
    "requested_at",
    "due_at",
    "expected_min_s",
    "expected_max_s",
    "pending_kind",
    "pending_priority",
    "pending_requested_at",
    "wait_started_at",
    "manual_wait_until",
    "sources_read_at",
    "current_run_id",
    "tecfil_state",
    "tecfil_lease_until",
    "tecfil_due_at",
    "outcome",
    "outcome_payload",
  ])("gives oil_research a nullable %s", (column) => {
    const line = tableBody("oil_research")
      .split("\n")
      .find((entry) => entry.trim().startsWith(`"${column}" `));
    expect(line).toBeDefined();
    expect(line).not.toContain("NOT NULL");
  });

  it("records a run's timings and cost, summed by started_at", () => {
    const body = tableBody("oil_research_run");
    for (const column of ['"started_at" TIMESTAMPTZ(3) NOT NULL', '"cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0', '"picker_cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0', '"usage_known" BOOLEAN NOT NULL DEFAULT true', '"path" TEXT NOT NULL']) {
      expect(body).toContain(column);
    }
    expect(sql).toContain('CREATE INDEX "oil_research_run_started_at_idx" ON "oil_research_run"("started_at");');
    expect(sql).toMatch(/"oil_research_run_research_id_fkey"[^;]*ON DELETE SET NULL/);
  });

  it("keeps the runner in one row with its heartbeat, day, spend, budget, pause and watermark", () => {
    const body = tableBody("oil_research_runner");
    expect(body).toContain(`"id" TEXT NOT NULL DEFAULT 'runner'`);
    for (const column of ["last_seen_at", "key_set", "day", "day_spend_usd", "budget_usd", "paused_reason", "paused_until", "sweep_watermark"]) {
      expect(body).toContain(`"${column}"`);
    }
  });

  it("alters nothing that exists", () => {
    expect(sql).not.toMatch(/ALTER TABLE "(?!oil_research_run")/);
    expect(sql).not.toMatch(/DROP /);
  });
});
