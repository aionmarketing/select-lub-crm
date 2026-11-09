/**
 * Test design (testing-strategy) — what research records for what the pipeline returned
 *
 * SUT: `resolveOilSpec`'s `incomplete` / `webNotSearched` report, and `mapPipelineResult`, D10's
 *   table. Pure: fake ports, no database, no model.
 *
 * Oracle: background-oil-research D10 ("What the pipeline reports" and the mapping table):
 *   - `incomplete` when an extraction failed, an escalation failed (not declined), the web search
 *     was left incomplete, or a local adapter answered `unavailable`;
 *   - a verified spec is kept whether complete or not, carrying `incomplete`;
 *   - a miss, a clarification or a conflict that is incomplete is transient — a clarification or a
 *     conflict as its fallback for the last attempt; `unavailable` is transient with no fallback;
 *   - a complete `no_spec` whose web did not run is `searched: false`;
 *   - a clarification keeps the engines named — none, one or several.
 * Mutation-checked: dropping `extractionFailed` from `incomplete` fails the timeout case; mapping
 *   an incomplete clarification to itself fails the transient-fallback case.
 */
import { describe, expect, it } from "vitest";
import { ESCALATION_FAILED, EXTRACTION_FAILED, resolveOilSpec, type OilSpecPorts, type RetrieveResult, type RetrievedSource } from "../pipeline/oil-spec.js";
import { mapPipelineResult } from "./outcome.js";

const IDENTITY = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0 FLEX 12V 4P" };
const NOW = new Date("2026-09-26T15:00:00.000Z");

const page = (publisher: string, text: string, authority: 1 | 2 | 3 | 4 | 5 = 3): RetrievedSource => ({
  publisher,
  document: "Manual",
  page: "p. 3",
  authority,
  content: { kind: "text", text },
});

function ports(retrieved: RetrieveResult, extract: OilSpecPorts["extract"], escalate?: OilSpecPorts["escalate"]): OilSpecPorts {
  return { retrieve: async () => retrieved, extract, ...(escalate ? { escalate } : {}) };
}

const spec = (grades: string[], liters: number) => ({
  viscosityGrades: grades,
  classification: "",
  fillLiters: liters,
  fillKind: "em_servico" as const,
  engineCoverage: "one" as const,
});

describe("resolveOilSpec — what research needs beside the result", () => {
  it("reports a timed-out extraction as incomplete, not as a complete miss", async () => {
    const result = await resolveOilSpec(IDENTITY, ports({ status: "found", sources: [page("a", "x")] }, async () => EXTRACTION_FAILED));

    expect(result.status).toBe("no_spec");
    expect(result.incomplete).toBe(true);
    expect(mapPipelineResult(result, IDENTITY, NOW)).toEqual({ kind: "transient" });
  });

  it("reports a page that stated nothing as a complete miss", async () => {
    const result = await resolveOilSpec(IDENTITY, ports({ status: "found", sources: [page("a", "x")] }, async () => null));

    expect(result.incomplete).toBeUndefined();
    expect(mapPipelineResult(result, IDENTITY, NOW)).toEqual({ kind: "no_spec", searched: true });
  });

  it("reports a retrieval left incomplete — a page unread (503) — as transient", async () => {
    const result = await resolveOilSpec(IDENTITY, ports({ status: "none", incomplete: true }, async () => null));

    expect(result.status).toBe("no_spec");
    expect(mapPipelineResult(result, IDENTITY, NOW)).toEqual({ kind: "transient" });
  });

  it("records a miss the web could not search for as not searched", async () => {
    const result = await resolveOilSpec(IDENTITY, ports({ status: "none", notSearched: true }, async () => null));

    expect(result.webNotSearched).toBe(true);
    expect(mapPipelineResult(result, IDENTITY, NOW)).toEqual({ kind: "no_spec", searched: false });
  });

  it("tells a failed escalation (transient, the conflict its fallback) from a declined one (a conflict)", async () => {
    const two: RetrieveResult = { status: "found", sources: [page("a", "a", 3), page("b", "b", 3)] };
    const extract: OilSpecPorts["extract"] = async (source) => (source.publisher === "a" ? spec(["5W-30"], 4) : spec(["5W-40"], 4));

    const failed = await resolveOilSpec(IDENTITY, ports(two, extract, async () => ESCALATION_FAILED));
    const declined = await resolveOilSpec(IDENTITY, ports(two, extract, async () => null));

    expect(failed.status).toBe("conflicting_sources");
    const failedMap = mapPipelineResult(failed, IDENTITY, NOW);
    expect(failedMap.kind).toBe("transient");
    expect(failedMap).toMatchObject({ fallback: { outcome: "conflicting_sources" } });
    expect(mapPipelineResult(declined, IDENTITY, NOW).kind).toBe("conflicting_sources");
  });

  it("keeps a verified spec that is incomplete, and says so", async () => {
    const result = await resolveOilSpec(
      IDENTITY,
      ports({ status: "found", sources: [page("a", "a"), page("b", "b")] }, async (source) => (source.publisher === "a" ? spec(["5W-40"], 4) : EXTRACTION_FAILED)),
    );

    const mapped = mapPipelineResult(result, IDENTITY, NOW);
    expect(mapped.kind).toBe("verified");
    expect(mapped).toMatchObject({ incomplete: true, cacheRow: { make: "Volkswagen", viscosityGrades: ["5W-40"], fillLiters: 4, sourcePublisher: "a" } });
  });

  // ingest-harvested-manuals D5: the cache row keeps the capacity type, and a volume a change does
  // not use, so the quote can name it without re-reading anything.
  it.each([
    [{ fillKind: "em_servico" as const, fillCondition: "with_filter" as const }, { fillLiters: 4, fillKind: "em_servico", fillCondition: "with_filter", unusableFillLiters: null }],
    [{ fillKind: "unlabeled" as const, fillCondition: "unlabeled" as const }, { fillLiters: 4, fillKind: "unlabeled", fillCondition: "unlabeled", unusableFillLiters: null }],
    [{ fillKind: null, fillCondition: "dry" as const }, { fillLiters: null, fillKind: null, fillCondition: "dry", unusableFillLiters: 4 }],
    [{ fillKind: null, fillCondition: "without_filter" as const }, { fillLiters: null, fillKind: null, fillCondition: "without_filter", unusableFillLiters: 4 }],
  ])("records the capacity type %o on the cache row", async (fill, row) => {
    const result = await resolveOilSpec(IDENTITY, ports({ status: "found", sources: [page("a", "a")] }, async () => ({ ...spec(["5W-40"], 4), ...fill })));

    expect(mapPipelineResult(result, IDENTITY, NOW)).toMatchObject({ kind: "verified", cacheRow: row });
  });
});

describe("mapPipelineResult", () => {
  it("keeps the engines a clarification named — none, one or several", () => {
    for (const options of [[], ["1.6 MSI"], ["1.0", "1.6"]]) {
      expect(mapPipelineResult({ status: "needs_clarification", coverage: "mismatch", options }, IDENTITY, NOW)).toEqual({
        kind: "needs_clarification",
        payload: { coverage: "mismatch", options },
      });
    }
  });

  it("makes an incomplete clarification transient, with the clarification as its fallback", () => {
    expect(mapPipelineResult({ status: "needs_clarification", coverage: "several", options: ["1.0"], incomplete: true }, IDENTITY, NOW)).toEqual({
      kind: "transient",
      fallback: { outcome: "needs_clarification", payload: { coverage: "several", options: ["1.0"] } },
    });
  });

  it("makes every adapter down transient, with no fallback", () => {
    expect(mapPipelineResult({ status: "unavailable" }, IDENTITY, NOW)).toEqual({ kind: "transient" });
  });
});
