/**
 * Test design (testing-strategy)
 *
 * SUT: the committed ingested sources (packages/core/fixtures/oil-sources.json) read through
 * oilSourceFixtures(). No HTTP, no DB, no model.
 *
 * Oracle: oil-quote-liters-pricing task 1.1 and specs/demo-seed/spec.md — "Demo spec and
 * Tecfil rows come from committed fixtures": every quote-capable identity carries a
 * non-empty SAE list, service-fill liters, a fill kind, and a citation. The fixture MUST
 * NOT invent grades or liters without that citation.
 *
 * Axes
 *   F1 identity completeness — all four fields non-empty after trim
 *   F2 grade list — non-empty, and every entry a real SAE multigrade
 *   F3 capacity — liters > 0 and within a crankcase's range, with a legend
 *   F4 legend value — em_servico / unlabeled, never seco
 *   F5 citation — publisher, document, page and a verbatim excerpt, all non-empty
 *   F6 excerpt supports the extraction — every recorded grade appears in the excerpt text
 *
 * Outputs: O1 pass/fail per fixture entry
 *
 * Sampled cells: every committed entry is checked against every axis (test.each over the
 * file), because a fixture that drifts from its excerpt is exactly the failure this file
 * exists to catch, and there are few enough entries to check them all.
 *
 * Out of scope: whether the cited document is itself correct about the car (a human reads
 * the URL for that); the live model extraction (D8 keeps models out of `pnpm test`).
 */
import { describe, expect, it } from "vitest";
import { motulCompatibilitySchema } from "../src/modules/quotes/contracts/http.js";
import { oilSourceFixtures } from "../src/kernel/prisma/oil-source-fixtures.js";

const SAE = /^\d{1,2}W-\d{1,2}$/;
const fixtures = oilSourceFixtures();

describe("committed ingested oil sources", () => {
  it("ships at least one quote-capable identity", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures.map((f) => [`${f.make} ${f.model} ${f.year} ${f.version}`, f] as const))(
    "%s carries a complete, cited, verified spec",
    (_label, fixture) => {
      expect(fixture.make.trim()).not.toBe("");
      expect(fixture.model.trim()).not.toBe("");
      expect(fixture.version.trim()).not.toBe("");
      expect(Number.isInteger(fixture.year)).toBe(true);

      expect(fixture.viscosityGrades.length).toBeGreaterThan(0);
      for (const grade of fixture.viscosityGrades) {
        expect(grade).toMatch(SAE);
      }

      expect(fixture.fillLiters).toBeGreaterThan(0);
      expect(fixture.fillLiters).toBeLessThanOrEqual(20);
      // "seco" is the value that must never appear: dry fill would overfill the engine.
      expect(["em_servico", "unlabeled"]).toContain(fixture.fillKind);

      expect(fixture.publisher.trim()).not.toBe("");
      expect(fixture.document.trim()).not.toBe("");
      expect(fixture.page.trim()).not.toBe("");
      expect(fixture.url.trim()).not.toBe("");
      expect(fixture.excerpt.trim()).not.toBe("");
      // The tier is the one fact about a source the extractor cannot read off the passage.
      expect([1, 2, 3, 4, 5]).toContain(fixture.authority);
    },
  );

  it.each(fixtures.map((f) => [`${f.make} ${f.model} ${f.year}`, f] as const))(
    "%s only records grades its own excerpt states",
    (_label, fixture) => {
      // The anti-invention check: a grade in the record that is nowhere in the passage
      // means someone typed what they believed instead of what the document said.
      for (const grade of fixture.viscosityGrades) {
        const compact = grade.replace("-", "");
        const excerpt = fixture.excerpt.replace(/-/g, "");
        expect(excerpt).toContain(compact);
      }
    },
  );

  it.each(fixtures.map((f) => [`${f.make} ${f.model} ${f.year}`, f] as const))(
    "%s only records a volume its own excerpt states",
    (_label, fixture) => {
      // Accept either decimal separator: sources write 3,6 and 3.6 alike.
      const comma = String(fixture.fillLiters).replace(".", ",");
      const dot = String(fixture.fillLiters);
      expect(
        fixture.excerpt.includes(comma) || fixture.excerpt.includes(dot),
      ).toBe(true);
    },
  );
  // The pairing that was missing, and is why a schema could contradict the data
  // it describes for as long as it did: nothing asserted that the classification
  // the seed writes is one the schema accepts. `motulCompatibilitySchema` had
  // `classification: z.string().trim().min(1)` while every fixture row carries
  // `""` truthfully — these sources state grades and capacity and no API or ACEA
  // class. It never failed because nothing in production parses that schema, so
  // it was latent rather than broken; wiring it up would have produced a 500 on
  // rows the seed had already written. Restoring `min(1)` now fails here.
  it.each(fixtures.map((f) => [`${f.make} ${f.model} ${f.year}`, f] as const))(
    "%s carries a classification the compatibility schema accepts",
    (_label, fixture) => {
      const result = motulCompatibilitySchema
        .shape.classification.safeParse(fixture.classification);

      expect(result.success, `classification ${JSON.stringify(fixture.classification)} rejected`).toBe(true);
    },
  );
});
