/**
 * Test design (testing-strategy)
 *
 * Setup: read migration.sql from disk. No Postgres required.
 *
 * Oracle: split-catalog-lubricant-detail task 1.1 — CatalogItem is
 * generic (description, stock); oil spec copies onto catalog_lubricant;
 * quote line snapshot renames product_line → description.
 *
 * Axes
 *   A1 SQL adds description/stock, copies oils into the child, drops Motul columns
 *
 * Outputs: O1 tokens present / Motul-shaped columns gone from catalog_item
 *
 * Sampled-cell
 *   child table + copy + drop product_line | A1 | O1 | missing name
 *
 * Out of scope: live migrate (db:generate / operator migrate); seed rewrite (task 1.2).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../prisma/migrations/20260902120000_split_catalog_lubricant_detail/migration.sql",
  ),
  "utf8",
);

describe("split catalog lubricant migration", () => {
  it("copies oils onto catalog_lubricant and leaves catalog_item without product_line", () => {
    expect(sql).toContain('CREATE TABLE "catalog_lubricant"');
    expect(sql).toContain('"stock" DECIMAL(12,3)');
    expect(sql).toContain('"stock" = 0');
    expect(sql).toContain('SET "description" = "product_line"');
    expect(sql).toContain(
      'INSERT INTO "catalog_lubricant" ("catalog_item_id", "viscosity", "classification")',
    );
    expect(sql).toContain('SELECT "id", "viscosity", "classification" FROM "catalog_item"');
    expect(sql).toContain('ALTER TABLE "catalog_item" DROP COLUMN "product_line"');
    expect(sql).toContain('ALTER TABLE "catalog_item" DROP COLUMN "viscosity"');
    expect(sql).toContain('ALTER TABLE "catalog_item" DROP COLUMN "classification"');
    expect(sql).toContain('ALTER TABLE "oil_quote_line" DROP COLUMN "product_line"');
    expect(sql).toContain("catalog_lubricant_catalog_item_id_fkey");
  });
});
