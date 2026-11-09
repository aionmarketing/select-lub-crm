/**
 * Test design (testing-strategy)
 *
 * Setup: read migration.sql from disk. No Postgres required.
 *
 * Oracle: oil-quote-and-standalone-screens task 1.1 — CatalogItem,
 * OilQuote, OilQuoteLine snapshot columns (brand/product_line/price)
 * plus MotulCompatibility cache used by quote-options reuse.
 *
 * Axes
 *   A1 SQL creates the four tables and snapshot columns
 *
 * Outputs: O1 tokens present
 *
 * Sampled-cell
 *   tables + line snapshot + FKs | A1 | O1 | missing name
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
    "../../../prisma/migrations/20260831140000_oil_quote_catalog/migration.sql",
  ),
  "utf8",
);

describe("oil quote catalog migration", () => {
  it("creates catalog, quote, quote-line snapshot columns, and motul cache", () => {
    expect(sql).toContain('CREATE TABLE "catalog_item"');
    expect(sql).toContain('CREATE TABLE "oil_quote"');
    expect(sql).toContain('CREATE TABLE "oil_quote_line"');
    expect(sql).toContain('CREATE TABLE "motul_compatibility"');
    expect(sql).toContain('"product_line" TEXT NOT NULL');
    expect(sql).toContain('"price" DECIMAL(10,2) NOT NULL');
    expect(sql).toContain('"generated_message_text" TEXT NOT NULL');
    expect(sql).toContain("oil_quote_line_catalog_item_id_fkey");
  });
});
