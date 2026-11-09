/**
 * Test design (testing-strategy)
 *
 * Setup: read migration.sql from disk. No Postgres required.
 *
 * Oracle: tecfil-filter-pricing task 2.2 / design D6-D7 — tecfil_compatibility
 * carries the identity, the application labels, matched_by, the two candidate
 * lists, consulted_at, and raw_payload, with no price/vehicle/catalog columns;
 * catalog_filter is a child table keyed by catalog_item_id (a unique FK, like
 * catalog_lubricant) carrying filter_type and part_number, cascading on delete.
 *
 * Axes
 *   A1 tecfil_compatibility columns — identity, labels, matched_by/candidates, consulted_at
 *   A2 catalog_filter shape — PK is the FK, filter_type + part_number, cascade delete
 *
 * Outputs: O1 tokens present / Motul-cache-shaped extra columns absent
 *
 * Sampled-cell
 *   both tables created with their columns and FK | A1 A2 | O1 | missing column
 *
 * Out of scope: live migrate (db:generate / operator migrate, already run against the
 *   dev Postgres on 5433 during apply); seed rewrite (task 2.3); Prisma client shape.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../prisma/migrations/20260904161047_tecfil_filter_pricing/migration.sql",
  ),
  "utf8",
);

describe("tecfil filter pricing migration", () => {
  it("creates tecfil_compatibility with the fitment identity, labels, and candidate lists", () => {
    expect(sql).toContain('CREATE TABLE "tecfil_compatibility"');
    expect(sql).toContain('"make" TEXT NOT NULL');
    expect(sql).toContain('"year" INTEGER NOT NULL');
    expect(sql).toContain('"model" TEXT NOT NULL');
    expect(sql).toContain('"version" TEXT NOT NULL');
    expect(sql).toContain('"manufacturer_label" TEXT NOT NULL');
    expect(sql).toContain('"vehicle_label" TEXT NOT NULL');
    expect(sql).toContain('"engine_label" TEXT');
    expect(sql).toContain('"matched_by" JSONB NOT NULL');
    expect(sql).toContain('"oil_filters" JSONB NOT NULL');
    expect(sql).toContain('"fuel_filters" JSONB NOT NULL');
    expect(sql).toContain('"consulted_at" TIMESTAMP(3) NOT NULL');
    expect(sql).toContain('"raw_payload" JSONB');
    expect(sql).toContain(
      'CREATE INDEX "tecfil_compatibility_year_make_model_version_idx" ON "tecfil_compatibility"("year", "make", "model", "version")',
    );
  });

  it("does not give tecfil_compatibility a price, catalog item id, or vehicle id", () => {
    const table = sql.slice(
      sql.indexOf('CREATE TABLE "tecfil_compatibility"'),
      sql.indexOf(");", sql.indexOf('CREATE TABLE "tecfil_compatibility"')),
    );

    expect(table).not.toContain("price");
    expect(table).not.toContain("catalog_item_id");
    expect(table).not.toContain("vehicle_id");
  });

  it("creates catalog_filter keyed by catalog_item_id with a cascading FK", () => {
    expect(sql).toContain('CREATE TABLE "catalog_filter"');
    expect(sql).toContain('"catalog_item_id" TEXT NOT NULL');
    expect(sql).toContain('"filter_type" TEXT NOT NULL');
    expect(sql).toContain('"part_number" TEXT NOT NULL');
    expect(sql).toContain('CONSTRAINT "catalog_filter_pkey" PRIMARY KEY ("catalog_item_id")');
    expect(sql).toContain(
      'ALTER TABLE "catalog_filter" ADD CONSTRAINT "catalog_filter_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "catalog_item"("id") ON DELETE CASCADE ON UPDATE CASCADE',
    );
  });
});
