/**
 * Test design (testing-strategy)
 *
 * SUT: resolveOilSpec's refusal signals (internal/pipeline/oil-spec.ts) — the cases where a
 * source is in hand and the right answer is still NOT a verified spec.
 *
 * Split by topic under the 300-line cap (adopt-modular-vertical-slices 2B.1) from
 * oil-spec.test.ts, which holds the core resolution and the shared axes. Each section below
 * keeps the design block it had there.
 *
 * Setup: both ports are injected fakes (D8). No HTTP, no Motul, no model, no web search.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveOilSpec } from "./oil-spec.js";
import type {
  ExtractedOilSpec,
  OilSpecExtractor,
  OilSpecPorts,
} from "./oil-spec.js";
import type { VehicleIdentity } from "../store/store.js";

const identity: VehicleIdentity = {
  make: "Volkswagen",
  year: 2014,
  model: "Polo",
  version: "1.6 MSI",
};


/**
 * Added when the extractor gained `engineCoverage` (owner decision 2026-09-09).
 *
 * Oracle: specs/quotes/oil-quote/spec.md "Ambiguous engine is clarification" — more than one
 * engine matching the vehicle must reach the attendant, never be narrowed in silence.
 *
 * Axes
 *   E1 coverage reported — one / several / mismatch / unknown / absent
 *   E2 whether the passage named engines, for the clarification message
 *
 * Outputs: O6 the result status; O7 the options carried to the dialog
 *
 * Sampled cells (one row per `it`)
 *   several + names | E1,E2 | O6 needs_clarification, O7 the names verbatim |
 *      fails if a multi-engine table is extracted as though it described this car
 *   mismatch        | E1    | O6 needs_clarification
 *   unknown         | E1    | O6 verified | fails if an undecidable case blocks every quote
 *   absent          | E1    | O6 verified | fails if an older extractor stops working
 *
 * Out of scope — and this is the important line: whether a SINGLE-engine passage is about
 * the RIGHT engine. A model cannot decide that without pretrained memory about trims, and
 * measurement confirmed GLM-5.3-Flash answers `one` for the HR-V EX CVT / 1.5i-VTEC pair.
 * That resolution is GitHub #76 (a deterministic variant-to-engine table); no test here
 * should imply this signal covers it.
 */
describe("engine coverage is a refusal signal", () => {
  const source = {
    publisher: "CarroRac",
    document: "tabela de aplicação",
    page: "HR-V RU (2015-2026)",
    content: { kind: "text" as const, text: "três motores listados" },
  };

  function portsReporting(spec: ExtractedOilSpec): OilSpecPorts {
    return {
      retrieve: async () => ({ status: "found", sources: [source] }),
      extract: async () => spec,
    };
  }

  const grounded = {
    viscosityGrades: ["0W-20"],
    classification: "",
    fillLiters: 3.6,
    fillKind: "em_servico" as const,
  };

  it("asks for clarification, with the engines named, when the passage lists several", async () => {
    const result = await resolveOilSpec(identity, {
      ...portsReporting({
        ...grounded,
        engineCoverage: "several",
        enginesNamed: ["1.5 16V 173cv iVtec", "1.8 16V", "1.5 176cv Turbo"],
      }),
    });

    expect(result).toEqual({
      status: "needs_clarification",
      coverage: "several",
      options: ["1.5 16V 173cv iVtec", "1.8 16V", "1.5 176cv Turbo"],
      // The passage read is kept, so an engine pick can re-read it (background-oil-research D24).
      passages: [{ publisher: "CarroRac", document: "tabela de aplicação", page: "HR-V RU (2015-2026)", excerpt: "três motores listados" }],
    });
  });

  it("asks for clarification on a reported mismatch, and prices nothing", async () => {
    const result = await resolveOilSpec(
      identity,
      portsReporting({ ...grounded, engineCoverage: "mismatch", enginesNamed: ["1.8 16V"] }),
    );

    // One engine named is a valid clarification (background-oil-research D10).
    expect(result).toEqual({ status: "needs_clarification", coverage: "mismatch", options: ["1.8 16V"], passages: [{ publisher: "CarroRac", document: "tabela de aplicação", page: "HR-V RU (2015-2026)", excerpt: "três motores listados" }], });
  });

  it("does not block when coverage is undecidable", async () => {
    const result = await resolveOilSpec(
      identity,
      portsReporting({ ...grounded, engineCoverage: "unknown" }),
    );

    // `unknown` is common and honest; treating it as a block would empty most quotes.
    expect(result.status).toBe("verified");
  });

  it("does not block an extractor that reports no coverage at all", async () => {
    const result = await resolveOilSpec(identity, portsReporting(grounded));

    expect(result.status).toBe("verified");
  });

  it("hands the identity to the extractor so it can judge coverage", async () => {
    const extract = vi.fn<OilSpecExtractor>().mockResolvedValue(grounded);

    await resolveOilSpec(identity, {
      retrieve: async () => ({ status: "found", sources: [source] }),
      extract,
    });

    expect(extract).toHaveBeenCalledWith(source, identity);
  });
});
