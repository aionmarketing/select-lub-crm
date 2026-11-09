/**
 * Test design (testing-strategy)
 *
 * SUT: resolveOilSpec when several validated sources answer (internal/pipeline/oil-spec.ts
 * and conflicts.ts) — which disagreements are surfaced, how a subset is merged, and which
 * source each grade and the liters are cited to.
 *
 * Split out of oil-spec.refusals.test.ts under the 300-line cap when the per-grade citation
 * cases (oil-quote-retrieval-hardening 7.2) and the overlapping-sets case (review of #175)
 * were added. The design block below is the one it had there.
 *
 * Setup: both ports are injected fakes (D8). No HTTP, no Motul, no model, no web search.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveOilSpec } from "./oil-spec.js";
import type { ExtractedOilSpec, OilSpecExtractor, OilSpecPorts, RetrievedSource } from "./oil-spec.js";
import type { VehicleIdentity } from "../store/store.js";

const identity: VehicleIdentity = {
  make: "Volkswagen",
  year: 2014,
  model: "Polo",
  version: "1.6 MSI",
};

/**
 * Added with conflict detection and escalation (owner decision 2026-09-09; prompt.md
 * "Conflict handling" and "Model routing").
 *
 * Oracle: two validated sources disagreeing must be surfaced, never averaged or silently
 * decided; one escalation read may settle it, but only within the values the sources
 * themselves stated; a lower-authority source must not silently override a higher one.
 *
 * Axes
 *   C1 agreement — agree / disagree on liters / disagree on grade set / one silent on liters
 *   C2 authority order in the retrieved list — best first / best listed LAST (sort must fix it)
 *   C3 escalator — absent / answers a candidate value / answers a value nobody cited / null
 *
 * Outputs: O1 status; O2 which citation wins; O3 conflict values in authority order;
 *          O4 whether the escalator was called, and with what
 *
 * Sampled cells (one row per `it`)
 *   agree, best listed last     | C1,C2 | O2 tier-1 citation | fails if list order wins
 *   liters differ, no escalator | C1,C3 | O1 conflicting, O3 tier-1 value first
 *   grade sets differ           | C1    | O1 conflicting on viscosityGrades
 *   one silent on liters        | C1    | O1 verified, liters filled from the source that
 *      stated them — a gap filled is not an override
 *   escalator picks 4.3         | C3    | O1 verified, settledByEscalation, O4 once
 *   escalator invents 4.5       | C3    | O1 conflicting | THE guardrail: fails if the
 *      stronger model can introduce a number no source cited
 *   escalator null              | C3    | O1 conflicting
 *   no conflict                 | C3    | O4 escalator never called
 */
describe("conflicting sources", () => {
  type Escalator = NonNullable<OilSpecPorts["escalate"]>;

  const catalog: RetrievedSource = {
    publisher: "CarroRac",
    document: "tabela de aplicação",
    page: "Polo AW, 1.0 TSI",
    authority: 5,
    content: { kind: "text", text: "catálogo: 4 L" },
  };
  const manual: RetrievedSource = {
    publisher: "Volkswagen do Brasil",
    document: "Manual do Proprietário Polo 2021",
    page: "p. 287",
    authority: 1,
    url: "https://example.test/manual.pdf",
    content: { kind: "text", text: "manual: 4,3 L" },
  };

  const fourLiters: ExtractedOilSpec = {
    viscosityGrades: ["0W-20", "5W-30"],
    classification: "",
    fillLiters: 4,
    fillKind: "em_servico",
  };

  /** An extractor whose answer depends on which passage it was handed. */
  function extractorBySource(byPage: Record<string, ExtractedOilSpec | null>): OilSpecExtractor {
    return async (source) => byPage[source.page] ?? null;
  }

  function ports(
    sources: RetrievedSource[],
    byPage: Record<string, ExtractedOilSpec | null>,
    escalate?: Escalator,
  ): OilSpecPorts {
    return {
      retrieve: async () => ({ status: "found", sources }),
      extract: extractorBySource(byPage),
      ...(escalate ? { escalate } : {}),
    };
  }

  it("verifies from the highest-authority source even when it was retrieved last", async () => {
    const result = await resolveOilSpec(
      identity,
      ports([catalog, manual], { [catalog.page]: fourLiters, [manual.page]: fourLiters }),
    );

    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("expected verified");
    expect(result.citation.authority).toBe(1);
    expect(result.citation.publisher).toBe("Volkswagen do Brasil");
    expect(result.settledByEscalation).toBeUndefined();
  });

  it("surfaces a litre disagreement with the higher authority first, and no escalator", async () => {
    const result = await resolveOilSpec(
      identity,
      ports([catalog, manual], {
        [catalog.page]: fourLiters,
        [manual.page]: { ...fourLiters, fillLiters: 4.3 },
      }),
    );

    expect(result.status).toBe("conflicting_sources");
    if (result.status !== "conflicting_sources") throw new Error("expected conflict");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.field).toBe("fillLiters");
    expect(result.conflicts[0]!.values.map((entry) => entry.value)).toEqual(["4.3", "4"]);
    expect(result.conflicts[0]!.values[0]!.citation.authority).toBe(1);
  });

  it("surfaces a grade-set disagreement: each lists a grade the other does not", async () => {
    const result = await resolveOilSpec(
      identity,
      ports([manual, catalog], {
        [manual.page]: { ...fourLiters, viscosityGrades: ["0W-20"] },
        [catalog.page]: { ...fourLiters, viscosityGrades: ["5W-40"] },
      }),
    );

    expect(result.status).toBe("conflicting_sources");
    if (result.status !== "conflicting_sources") throw new Error("expected conflict");
    expect(result.conflicts.map((conflict) => conflict.field)).toEqual(["viscosityGrades"]);
  });

  // Orchestrator review of #175: sharing a grade is not agreeing. Each lists one the other
  // lacks, so neither is a subset, and the union would offer a grade one source rules out.
  it("surfaces overlapping sets that each list a grade the other does not", async () => {
    const result = await resolveOilSpec(
      identity,
      ports([manual, catalog], {
        [manual.page]: { ...fourLiters, viscosityGrades: ["0W-20", "5W-30"] },
        [catalog.page]: { ...fourLiters, viscosityGrades: ["5W-30", "5W-40"] },
      }),
    );

    expect(result.status).toBe("conflicting_sources");
    if (result.status !== "conflicting_sources") throw new Error("expected conflict");
    expect(result.conflicts.map((conflict) => conflict.field)).toEqual(["viscosityGrades"]);
    expect(result.conflicts[0]!.values.map((entry) => entry.value)).toEqual(["0W-20, 5W-30", "5W-30, 5W-40"]);
  });

  /** Each grade's cited page, in grade order — the shape the per-grade assertions read. */
  function citedPages(result: { gradeCitations: { grade: string; citation: { page: string } }[] }) {
    return result.gradeCitations.map(({ grade, citation }) => [grade, citation.page]);
  }

  // oil-quote-retrieval-hardening 7.1 (D11): a subset is not a disagreement, and 7.2 (owner,
  // 2026-09-25): each grade is cited to the highest-authority source that LISTS it.
  it("verifies a subset with the union, each grade cited to a source that lists it", async () => {
    const result = await resolveOilSpec(
      identity,
      ports([manual, catalog], {
        [manual.page]: { ...fourLiters, viscosityGrades: ["5W-30"] },
        [catalog.page]: fourLiters,
      }),
    );

    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("expected verified");
    // The manual's grade first, then what only the catalog named.
    expect(result.viscosityGrades).toEqual(["5W-30", "0W-20"]);
    expect(result.citation.page).toBe(manual.page);
    expect(result.fillLiters).toBe(4);
    // The manual does not list 0W-20, so it is never 0W-20's source.
    expect(citedPages(result)).toEqual([
      ["5W-30", manual.page],
      ["0W-20", catalog.page],
    ]);
    // Both state 4 L; the higher authority is cited for it.
    expect(result.litersCitation?.page).toBe(manual.page);
  });

  it("cites every grade to the higher authority when it lists the superset", async () => {
    const result = await resolveOilSpec(
      identity,
      ports([manual, catalog], {
        [manual.page]: fourLiters,
        [catalog.page]: { ...fourLiters, viscosityGrades: ["5W-30"] },
      }),
    );

    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("expected verified");
    expect(citedPages(result)).toEqual([
      ["0W-20", manual.page],
      ["5W-30", manual.page],
    ]);
  });

  it("still surfaces a liters disagreement between sources whose grades agree by subset", async () => {
    const result = await resolveOilSpec(
      identity,
      ports([manual, catalog], {
        [manual.page]: { ...fourLiters, viscosityGrades: ["5W-30"], fillLiters: 4.3 },
        [catalog.page]: fourLiters,
      }),
    );

    expect(result.status).toBe("conflicting_sources");
    if (result.status !== "conflicting_sources") throw new Error("expected conflict");
    expect(result.conflicts.map((conflict) => conflict.field)).toEqual(["fillLiters"]);
  });

  it("treats a source silent on liters as filling a gap, not as a conflict", async () => {
    const result = await resolveOilSpec(
      identity,
      ports([manual, catalog], {
        [manual.page]: { ...fourLiters, fillLiters: null, fillKind: null },
        [catalog.page]: fourLiters,
      }),
    );

    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("expected verified");
    // Grades and citation from the manual; the volume from, and cited to, the only source
    // that stated it.
    expect(result.citation.authority).toBe(1);
    expect(result.fillLiters).toBe(4);
    expect(citedPages(result)).toEqual([
      ["0W-20", manual.page],
      ["5W-30", manual.page],
    ]);
    expect(result.litersCitation?.page).toBe(catalog.page);
  });

  it("cites no liters source when no source stated liters", async () => {
    const result = await resolveOilSpec(
      identity,
      ports([manual], { [manual.page]: { ...fourLiters, fillLiters: null, fillKind: null } }),
    );

    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("expected verified");
    expect(result.litersCitation).toBeNull();
  });

  it("cites an escalation's liters to the source that stated that figure", async () => {
    // The escalation settles on the catalog's 4 L over the manual's 4,3 L: citing the
    // manual — the top source — would attribute a figure it never stated.
    const escalate = vi.fn<Escalator>().mockResolvedValue(fourLiters);

    const result = await resolveOilSpec(
      identity,
      ports(
        [catalog, manual],
        { [catalog.page]: fourLiters, [manual.page]: { ...fourLiters, fillLiters: 4.3 } },
        escalate,
      ),
    );

    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("expected verified");
    expect(result.fillLiters).toBe(4);
    expect(result.citation.page).toBe(manual.page);
    expect(result.litersCitation?.page).toBe(catalog.page);
  });

  it("accepts an escalation answer that picks one of the cited values", async () => {
    const escalate = vi.fn<Escalator>().mockResolvedValue({ ...fourLiters, fillLiters: 4.3 });

    const result = await resolveOilSpec(
      identity,
      ports(
        [catalog, manual],
        { [catalog.page]: fourLiters, [manual.page]: { ...fourLiters, fillLiters: 4.3 } },
        escalate,
      ),
    );

    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("expected verified");
    expect(result.fillLiters).toBe(4.3);
    expect(result.settledByEscalation).toBe(true);
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate.mock.calls[0]![0].conflicts[0]!.field).toBe("fillLiters");
  });

  it("refuses an escalation answer that no source stated", async () => {
    // 4.5 appears in neither passage. A stronger model must be able to choose between what
    // the sources said; it must never be able to add to it.
    const escalate = vi.fn<Escalator>().mockResolvedValue({ ...fourLiters, fillLiters: 4.5 });

    const result = await resolveOilSpec(
      identity,
      ports(
        [catalog, manual],
        { [catalog.page]: fourLiters, [manual.page]: { ...fourLiters, fillLiters: 4.3 } },
        escalate,
      ),
    );

    expect(result.status).toBe("conflicting_sources");
  });

  it("falls back to the conflict when the escalation read declines", async () => {
    const escalate = vi.fn<Escalator>().mockResolvedValue(null);

    const result = await resolveOilSpec(
      identity,
      ports(
        [catalog, manual],
        { [catalog.page]: fourLiters, [manual.page]: { ...fourLiters, fillLiters: 4.3 } },
        escalate,
      ),
    );

    expect(result.status).toBe("conflicting_sources");
  });

  it("never escalates when the sources agree", async () => {
    const escalate = vi.fn<Escalator>().mockResolvedValue(null);

    await resolveOilSpec(
      identity,
      ports([catalog, manual], { [catalog.page]: fourLiters, [manual.page]: fourLiters }, escalate),
    );

    expect(escalate).not.toHaveBeenCalled();
  });
});
