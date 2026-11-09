/**
 * Test design (testing-strategy)
 *
 * Setup: read migration.sql from disk. No Postgres required.
 *
 * Oracle: oil-quote-liters-pricing task 2.2 and design D2 — the identity cache gains
 * the verified spec's grade list, service-fill liters, capacity kind, and provenance.
 *
 * Axes
 *   A1 the six new columns exist on motul_compatibility
 *   A2 every one of them is nullable, so pre-grounding rows survive the migration
 *      (the deliberate case: a NOT NULL add without a default would fail on a
 *      populated table, and a NOT NULL add *with* a default would silently give
 *      historical rows a fabricated spec — which the change forbids)
 *   A3 liters keep decimal precision rather than becoming an integer litre count
 *
 * Outputs: O1 tokens present  O2 no NOT NULL on the added columns
 *
 * Out of scope: live migrate; the API's null-to-[viscosity] read (options.ts owns
 * that); whether a value is service fill (the validator owns that).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../prisma/migrations/20260909170000_oil_spec_liters_provenance/migration.sql",
  ),
  "utf8",
);

const addedColumns = [
  '"viscosities" JSONB',
  '"fill_liters" DECIMAL(6,3)',
  '"fill_kind" TEXT',
  '"source_publisher" TEXT',
  '"source_document" TEXT',
  '"source_page" TEXT',
];

describe("oil spec liters and provenance migration", () => {
  it.each(addedColumns)("adds %s to motul_compatibility", (column) => {
    expect(sql).toContain(`ALTER TABLE "motul_compatibility" ADD COLUMN ${column}`);
  });

  it("leaves every added column nullable, so historical rows keep no invented spec", () => {
    const addStatements = sql
      .split("\n")
      .filter((line) => line.includes("ADD COLUMN"));

    expect(addStatements).toHaveLength(addedColumns.length);
    for (const statement of addStatements) {
      expect(statement).not.toContain("NOT NULL");
      expect(statement).not.toContain("DEFAULT");
    }
  });
});

/**
 * Added by web-search-source-adapter task 1.1.
 *
 * Oracle: the same rule as the earlier column additions — a web-source column added NOT NULL
 * would fail on a populated table, and NOT NULL with a default would hand every historical
 * row a fabricated classification. Both must be nullable and defaultless.
 */
const webSourceSql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../prisma/migrations/20260910020000_oil_spec_web_source/migration.sql",
  ),
  "utf8",
);

describe("web source columns migration", () => {
  it.each(['"source_classification" TEXT', '"source_excerpt" TEXT'])(
    "adds %s to motul_compatibility",
    (column) => {
      expect(webSourceSql).toContain(
        `ALTER TABLE "motul_compatibility" ADD COLUMN ${column}`,
      );
    },
  );

  it("leaves both nullable and without a default", () => {
    const addStatements = webSourceSql
      .split("\n")
      .filter((line) => line.includes("ADD COLUMN"));

    expect(addStatements).toHaveLength(2);
    for (const statement of addStatements) {
      expect(statement).not.toContain("NOT NULL");
      expect(statement).not.toContain("DEFAULT");
    }
  });
});
