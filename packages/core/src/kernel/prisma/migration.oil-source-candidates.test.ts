/**
 * Test design (testing-strategy)
 *
 * Setup: read migration.sql from disk. No Postgres required.
 *
 * Oracle: specs/quotes/oil-source-candidates/spec.md ("Every manual candidate is persisted, not
 * counted" — identity, url, publisher, classification, tier, when, and whether it came from
 * a page; insert-only) and specs/quotes/oil-spec-web-search/spec.md ("A miss is not searched again
 * within a window" — a miss is remembered per identity with a time and a reason).
 *
 * Axes
 *   C1 oil_source_candidate columns — the seven required / the three optional
 *   C2 nullability — required columns NOT NULL / `discovered_via`, `label`,
 *      `selection_reason` nullable
 *   M1 oil_spec_search_miss columns — identity, reason, searched_at
 *   K1 keys — a primary key on each; NO unique constraint on the identity or the URL
 *   I1 lookup — an index on the identity tuple of each table
 *
 * Outputs: O1 tokens present  O2 NOT NULL exactly where the spec requires it  O3 no
 *          uniqueness that would make a second find overwrite or fail
 *
 * Sampled cells (one row per `it` or `it.each` row)
 *   required candidate columns   | C1,C2 | O1 + O2 NOT NULL
 *   optional candidate columns   | C1,C2 | O1 + O2 nullable | THE case: `discovered_via`
 *      null is what distinguishes a document the model classified from one that inherited
 *      its page's class, so a NOT NULL here would erase the distinction the spec relies on
 *   miss columns                 | M1    | O1
 *   no unique on candidates      | K1    | O3 "a repeat find keeps history" is impossible
 *      with a unique index on (identity, url) — a second insert would fail or upsert
 *   no unique on misses          | K1    | O3
 *   identity indexes             | I1    | present on both tables
 *
 * Out of scope: running the migration (no Postgres here); the store's read/write behaviour
 * (memory.test.ts); whether a candidate is correctly classified (admit.test.ts).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../prisma/migrations/20260914120000_oil_source_candidates_and_misses/migration.sql",
  ),
  "utf8",
);

const requiredCandidateColumns = [
  '"make" TEXT NOT NULL',
  '"year" INTEGER NOT NULL',
  '"model" TEXT NOT NULL',
  '"version" TEXT NOT NULL',
  '"url" TEXT NOT NULL',
  '"publisher" TEXT NOT NULL',
  '"classification" TEXT NOT NULL',
  '"tier" INTEGER NOT NULL',
  '"found_at" TIMESTAMPTZ(3) NOT NULL',
];

const optionalCandidateColumns = ["discovered_via", "label", "selection_reason"];

const missColumns = [
  '"make" TEXT NOT NULL',
  '"reason" TEXT NOT NULL',
  '"searched_at" TIMESTAMPTZ(3) NOT NULL',
];

/** The body of one CREATE TABLE statement, so a column assertion cannot match the other table. */
function tableBody(name: string): string {
  const start = sql.indexOf(`CREATE TABLE "${name}"`);
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf(");", start));
}

describe("oil source candidates and search misses migration", () => {
  it.each(requiredCandidateColumns)("gives oil_source_candidate %s", (column) => {
    expect(tableBody("oil_source_candidate")).toContain(column);
  });

  it.each(optionalCandidateColumns)("leaves oil_source_candidate.%s nullable", (column) => {
    // `discovered_via` null is what says the model classified this document itself rather
    // than inheriting its page's class. NOT NULL here would erase that distinction.
    const line = tableBody("oil_source_candidate")
      .split("\n")
      .find((l) => l.includes(`"${column}"`));

    expect(line).toBeDefined();
    expect(line).not.toContain("NOT NULL");
    expect(line).not.toContain("DEFAULT");
  });

  it.each(missColumns)("gives oil_spec_search_miss %s", (column) => {
    expect(tableBody("oil_spec_search_miss")).toContain(column);
  });

  it("puts no unique constraint on either table, so a repeat find keeps history", () => {
    expect(sql).not.toContain("CREATE UNIQUE INDEX");
    expect(sql).not.toContain("UNIQUE (");
  });

  it("indexes both tables by the identity tuple", () => {
    for (const table of ["oil_source_candidate", "oil_spec_search_miss"]) {
      expect(sql).toContain(`ON "${table}"("year", "make", "model", "version")`);
    }
  });
});
