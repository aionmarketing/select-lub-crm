/**
 * Test design (testing-strategy)
 *
 * Setup: read migration.sql from disk. No Postgres required.
 *
 * Oracle: review of #182 (L3): a reading's retries are bounded by an attempt count, so the
 *   reading table gains `attempts`, never null, 0 for every existing row; nothing else changes.
 *
 * Out of scope: running the migration; the store's behaviour (test/manual-reading.live.test.ts).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../prisma/migrations/20260926130000_oil_manual_reading_attempts/migration.sql"),
  "utf8",
);

describe("oil manual reading attempts migration", () => {
  it("adds attempts to the reading, never null, 0 on existing rows", () => {
    expect(sql).toContain('ALTER TABLE "oil_manual_reading" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;');
  });

  it("changes nothing else", () => {
    const statements = sql.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("--"));
    expect(statements).toHaveLength(1);
  });
});
