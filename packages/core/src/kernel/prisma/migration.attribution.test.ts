/**
 * Test design (testing-strategy)
 *
 * Setup: read migration.sql from disk. No Postgres required.
 *
 * Oracle: relatorios-attribution-metrics task 1.1 — versioned global
 * attribution_rule with a 30-day version-1 insert; two association
 * tables with unique service+anchor pairs (AC-REP-09).
 *
 * Axes
 *   A1 SQL creates three tables, unique pairs, and the v1 insert
 *
 * Outputs: O1 tokens present
 *
 * Sampled-cell
 *   tables + uniques + INSERT 1/30 | A1 | O1 | missing name
 *
 * Out of scope: live migrate.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../prisma/migrations/20260831160000_attribution_metrics/migration.sql",
  ),
  "utf8",
);

describe("attribution metrics migration", () => {
  it("creates the rule and association tables, unique pairs, and the 30-day version-1 row", () => {
    expect(sql).toContain('CREATE TABLE "attribution_rule"');
    expect(sql).toContain('CREATE TABLE "service_scheduled_attribution"');
    expect(sql).toContain('CREATE TABLE "service_conversation_attribution"');
    expect(sql).toContain("service_scheduled_attribution_service_id_scheduled_message_id_key");
    expect(sql).toContain("service_conversation_attribution_service_id_conversation_id_key");
    expect(sql).toContain('"window_days" INTEGER NOT NULL');
    expect(sql).toMatch(/INSERT INTO "attribution_rule"[\s\S]*\b1\b[\s\S]*\b30\b/);
  });
});
