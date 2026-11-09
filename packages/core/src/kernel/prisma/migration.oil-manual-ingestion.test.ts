/**
 * Test design (testing-strategy)
 *
 * Setup: read migration.sql from disk. No Postgres required.
 *
 * Oracle: ingest-harvested-manuals D3 (orchestrator, 2026-09-25) and oil-manual-ingestion
 *   "Ingested pages are stored with their checksum and reused" / "Ingestion runs off the quote
 *   path":
 *   - ingestion is keyed by the document's URL, once per URL, pending by default;
 *   - a download stores its SHA-256, size, pages and durations, and is insert-only (no unique
 *     on the URL, so a changed checksum adds a row);
 *   - a page is its document plus its number;
 *   - a reading is one per (URL, identity), pending by default: one download, a reading each;
 *   - oil_source_candidate is left untouched, so it stays insert-only.
 *
 * Out of scope: running the migration (no Postgres here); the store's behaviour (PR 2).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../prisma/migrations/20260926120000_oil_manual_ingestion/migration.sql"),
  "utf8",
);

/** The body of one CREATE TABLE statement, so a column assertion cannot match another table. */
function tableBody(name: string): string {
  const start = sql.indexOf(`CREATE TABLE "${name}"`);
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf(");", start));
}

describe("oil manual ingestion migration", () => {
  it("keys ingestion by URL, pending by default, with no attempts yet", () => {
    const body = tableBody("oil_manual_ingestion");
    expect(body).toContain('CONSTRAINT "oil_manual_ingestion_pkey" PRIMARY KEY ("url")');
    expect(body).toContain(`"state" TEXT NOT NULL DEFAULT 'pending'`);
    expect(body).toContain('"definite" BOOLEAN NOT NULL DEFAULT false');
    expect(body).toContain('"attempts" INTEGER NOT NULL DEFAULT 0');
  });

  it.each(['"sha256" TEXT NOT NULL', '"bytes" INTEGER NOT NULL', '"pages" INTEGER NOT NULL', '"fetch_ms" INTEGER NOT NULL', '"parse_ms" INTEGER NOT NULL'])(
    "gives oil_manual_document %s",
    (column) => {
      expect(tableBody("oil_manual_document")).toContain(column);
    },
  );

  it("keeps downloads insert-only: no unique on a document's URL", () => {
    expect(sql).not.toMatch(/UNIQUE INDEX "[^"]*" ON "oil_manual_document"/);
  });

  it("keys a page by its document and number, and drops pages with their document", () => {
    expect(tableBody("oil_manual_page")).toContain('PRIMARY KEY ("document_id","page_number")');
    expect(sql).toMatch(/"oil_manual_page_document_id_fkey"[^;]*ON DELETE CASCADE/);
  });

  it("gives each (URL, identity) exactly one reading, pending by default", () => {
    expect(tableBody("oil_manual_reading")).toContain(`"status" TEXT NOT NULL DEFAULT 'pending'`);
    expect(sql).toContain('ON "oil_manual_reading"("url", "make", "year", "model", "version")');
    expect(sql).toMatch(/CREATE UNIQUE INDEX "oil_manual_reading_url_make_year_model_version_key"/);
  });

  it("leaves oil_source_candidate untouched", () => {
    expect(sql).not.toContain('"oil_source_candidate"');
  });
});
