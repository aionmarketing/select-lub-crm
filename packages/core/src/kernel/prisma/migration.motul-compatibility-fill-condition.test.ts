/**
 * Test design (testing-strategy)
 *
 * Setup: read migration.sql from disk. No Postgres required.
 *
 * Oracle: ingest-harvested-manuals D5 and the oil-quote delta "The capacity type is recorded, and
 *   only an in-service volume prices the oil": the cache row records the capacity type and a
 *   volume a change does not use, both nullable with no backfill, so a row written before them
 *   reads as its existing legend; nothing else changes. It sorts after background-oil-research's
 *   last migration (20260927120000), so it applies on top of the research tables.
 *
 * Out of scope: running the migration; the store's reading of older rows (the quote tests).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../prisma/migrations/20260927130000_motul_compatibility_fill_condition/migration.sql"),
  "utf8",
);

describe("motul_compatibility fill condition migration", () => {
  it("adds the capacity type and the unusable volume, both nullable", () => {
    expect(sql).toContain('ALTER TABLE "motul_compatibility" ADD COLUMN "fill_condition" TEXT;');
    expect(sql).toContain('ALTER TABLE "motul_compatibility" ADD COLUMN "unusable_fill_liters" DECIMAL(6,3);');
  });

  it("changes nothing else and backfills nothing", () => {
    const statements = sql.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("--"));
    expect(statements).toHaveLength(2);
    expect(sql).not.toMatch(/NOT NULL|UPDATE /);
  });
});
