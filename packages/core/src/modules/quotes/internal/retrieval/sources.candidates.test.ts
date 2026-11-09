/**
 * Test design (testing-strategy) — an outage keeps the candidates the web found (oil-research-web-retrieval D4)
 *
 * SUT: gateWebSearch with injected local and web retrievers, and resolveOilSpec over it. No
 * socket, no model.
 *
 * Oracle: specs/quotes/oil-source-candidates "Every manual candidate is persisted, not counted"
 * — an adapter being down MUST NOT discard the candidates another adapter found. Before this
 * change the gate's last branch returned a bare `unavailable`.
 *
 * Axes
 *   U1 which adapter is down — the local one (Motul) / the web search itself / neither
 *   U2 the web's result — none with candidates / none without / found
 *
 * Sampled cells (one row per `it`)
 *   Motul down, web none + 1 candidate | U1,U2 | `unavailable` carrying the candidate
 *   Motul down, web none, no candidate | U1,U2 | a bare `unavailable`, no empty array
 *   Motul down, web found + candidate  | U1,U2 | `found`, incomplete, with the candidate (unchanged)
 *   the web search itself down         | U1    | a bare `unavailable` when it found nothing; `unavailable` carrying what it
 *      found before the provider failed
 *   resolveOilSpec over the first cell | U1,U2 | `unavailable` carrying \`manualCandidates\`, so the
 *      runner persists them whatever the outcome
 *
 * Out of scope: persisting them (the runner's live suite), the transient outcome's mapping
 * (outcome.test.ts).
 */
import { describe, expect, it } from "vitest";
import type { AuthoritativeSourceRetriever, ManualCandidate, RetrieveResult } from "../pipeline/oil-spec.js";
import { resolveOilSpec } from "../pipeline/oil-spec.js";
import type { VehicleIdentity } from "../store/store.js";
import { gateWebSearch } from "./sources.js";

const identity: VehicleIdentity = { make: "Hyundai", year: 2022, model: "HB20", version: "1.0 12V Flex" };
const candidate: ManualCandidate = {
  url: "https://www.hyundai.com.br/dam/hb20-2022.pdf",
  publisher: "hyundai.com.br",
  classification: "manufacturer_manual",
  tier: 1,
  label: "Manual HB20 2022",
};

const answering = (result: RetrieveResult): AuthoritativeSourceRetriever => async () => result;

describe("gateWebSearch with the local adapter down", () => {
  it("keeps the candidates the web found", async () => {
    const gated = gateWebSearch(answering({ status: "unavailable" }), answering({ status: "none", manualCandidates: [candidate] }));

    expect(await gated(identity)).toEqual({ status: "unavailable", manualCandidates: [candidate] });
  });

  it("stays a bare unavailable when the web found none", async () => {
    const gated = gateWebSearch(answering({ status: "unavailable" }), answering({ status: "none" }));

    expect(await gated(identity)).toEqual({ status: "unavailable" });
  });

  it("is unchanged when the web also found a source", async () => {
    const source = { publisher: "p", document: "d", page: "g", authority: 3 as const, content: { kind: "text" as const, text: "t" } };
    const gated = gateWebSearch(answering({ status: "unavailable" }), answering({ status: "found", sources: [source], manualCandidates: [candidate] }));

    expect(await gated(identity)).toMatchObject({ status: "found", incomplete: true, manualCandidates: [candidate] });
  });

  it("is a bare unavailable when the web search itself is down and found nothing to keep", async () => {
    const gated = gateWebSearch(answering({ status: "none" }), answering({ status: "unavailable" }));

    expect(await gated(identity)).toEqual({ status: "unavailable" });
  });

  it("keeps the candidates the web search found before its provider failed", async () => {
    const gated = gateWebSearch(answering({ status: "none" }), answering({ status: "unavailable", manualCandidates: [candidate] }));

    expect(await gated(identity)).toEqual({ status: "unavailable", manualCandidates: [candidate] });
  });
});

describe("resolveOilSpec over an unavailable retrieval", () => {
  it("returns the candidates beside the outage", async () => {
    const result = await resolveOilSpec(identity, {
      retrieve: answering({ status: "unavailable", manualCandidates: [candidate] }),
      extract: async () => null,
    });

    expect(result).toEqual({ status: "unavailable", manualCandidates: [candidate] });
  });

  it("returns none when there were none", async () => {
    const result = await resolveOilSpec(identity, { retrieve: answering({ status: "unavailable" }), extract: async () => null });

    expect(result).toEqual({ status: "unavailable" });
  });
});
