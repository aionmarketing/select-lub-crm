/**
 * Test design (testing-strategy) — what may be remembered as a miss, below the quote
 *
 * SUT: `gateWebSearch`'s account of the search (`webSearch`, and the empty-search miss), and
 *   `resolveOilSpec`'s `webFoundUnverified`, with injected retrievers and extractor.
 *
 * Oracle: oil-spec-web-search "A miss is not searched again within a window" (owner,
 *   2026-09-25) and the review of #176 — only a search that completed, with every admitted
 *   page read and every extraction run, is evidence of absence. An outage, "not searched", a
 *   page left unread or an extraction that did not run is not.
 *
 * Cells
 *   gate: web found, complete                 | webSearch complete, at the gate's clock
 *   gate: web found, a page unread            | webSearch not complete
 *   gate: web none, complete                  | the empty-search miss, at the gate's clock
 *   gate: web none, a page unread / not searched / unavailable | no miss
 *   gate: nothing local, web unavailable      | unavailable (an outage, not "not covered")
 *   pipeline: complete, nothing stated        | flagged with the gate's searchedAt (the Argo)
 *   pipeline: an extraction failed            | not flagged
 *   pipeline: search incomplete               | not flagged
 *   pipeline: a page verified / local only    | not flagged
 */
import { describe, expect, it, vi } from "vitest";
import { gateWebSearch, type SearchMissPort } from "../retrieval/sources.js";
import { EXTRACTION_FAILED, resolveOilSpec } from "./oil-spec.js";
import type {
  AuthoritativeSourceRetriever,
  ExtractedOilSpec,
  OilSpecExtractor,
  RetrieveResult,
  RetrievedSource,
} from "./oil-spec.js";
import type { VehicleIdentity } from "../store/store.js";

const identity: VehicleIdentity = { make: "Fiat", year: 2021, model: "Argo", version: "1.0 Firefly" };
const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const AT = new Date(NOW).toISOString();

const page: RetrievedSource = {
  publisher: "servicos.fiat.com.br",
  document: "Manuais",
  page: "Manuais",
  authority: 1,
  url: "https://servicos.fiat.com.br/manuais.html",
  content: { kind: "text", text: "Baixe o manual do seu Fiat." },
};

const catalog: RetrievedSource = { ...page, publisher: "CarroRac", page: "Argo", authority: 5, url: undefined };

const retrieverOf = (result: RetrieveResult) => vi.fn<AuthoritativeSourceRetriever>().mockResolvedValue(result);

function missStore() {
  const recorded: { reason: string; searchedAt: string }[] = [];
  const port: SearchMissPort = {
    latestSearchMiss: async () => null,
    recordSearchMiss: async (row) => {
      recorded.push({ reason: row.reason, searchedAt: row.searchedAt });
    },
  };
  return { recorded, port };
}

describe("the gate's account of the search", () => {
  it("reports a complete search, at its own clock", async () => {
    const gated = gateWebSearch(retrieverOf({ status: "found", sources: [catalog] }), retrieverOf({ status: "found", sources: [page] }), undefined, () => NOW);

    expect(await gated(identity)).toMatchObject({ webSearch: { sources: 1, complete: true, searchedAt: AT } });
  });

  it("reports a search with an admitted page left unread as incomplete", async () => {
    const gated = gateWebSearch(
      retrieverOf({ status: "found", sources: [catalog] }),
      retrieverOf({ status: "found", sources: [page], unreadAdmitted: 1 }),
      undefined,
      () => NOW,
    );

    expect(await gated(identity)).toMatchObject({ webSearch: { complete: false } });
  });

  it("remembers a complete empty search, at its own clock", async () => {
    const { recorded, port } = missStore();

    await gateWebSearch(retrieverOf({ status: "none" }), retrieverOf({ status: "none" }), port, () => NOW)(identity);

    expect(recorded).toEqual([{ reason: "nenhuma fonte admitida na busca", searchedAt: AT }]);
  });

  it.each([
    ["an admitted page left unread", { status: "none", unreadAdmitted: 2 }],
    ["no search at all", { status: "none", notSearched: true }],
    ["a provider outage", { status: "unavailable" }],
  ] as const)("does not remember %s", async (_label, web) => {
    const { recorded, port } = missStore();

    await gateWebSearch(retrieverOf({ status: "none" }), retrieverOf(web as RetrieveResult), port, () => NOW)(identity);

    expect(recorded).toEqual([]);
  });

  it("answers unavailable when nothing was found and the provider was down", async () => {
    const gated = gateWebSearch(retrieverOf({ status: "none" }), retrieverOf({ status: "unavailable" }));

    expect(await gated(identity)).toEqual({ status: "unavailable" });
  });
});

describe("resolveOilSpec says when a complete search verified nothing", () => {
  const verified: ExtractedOilSpec = { viscosityGrades: ["5W-30"], classification: "", fillLiters: 3, fillKind: "em_servico" };
  const complete = { sources: 1, complete: true, searchedAt: AT };

  async function resolve(retrieved: RetrieveResult, extract: OilSpecExtractor) {
    return resolveOilSpec(identity, { retrieve: async () => retrieved, extract });
  }

  it("flags the Argo with the gate's time: read, run, nothing stated", async () => {
    const result = await resolve({ status: "found", sources: [page], webSearch: complete }, async () => null);

    expect(result.status).toBe("no_spec");
    expect(result.webFoundUnverified).toEqual({ searchedAt: AT });
  });

  it("does not flag it when an extraction failed", async () => {
    const result = await resolve({ status: "found", sources: [page], webSearch: complete }, async () => EXTRACTION_FAILED);

    expect(result.status).toBe("no_spec");
    expect(result.webFoundUnverified).toBeUndefined();
  });

  it("does not flag an incomplete search", async () => {
    const result = await resolve(
      { status: "found", sources: [page], webSearch: { ...complete, complete: false } },
      async () => null,
    );

    expect(result.webFoundUnverified).toBeUndefined();
  });

  it("does not flag a search whose page verified", async () => {
    const result = await resolve({ status: "found", sources: [page], webSearch: complete }, async () => verified);

    expect(result.status).toBe("verified");
    expect(result.webFoundUnverified).toBeUndefined();
  });

  it("does not flag local sources that verified nothing when the web added none", async () => {
    const result = await resolve(
      { status: "found", sources: [catalog], webSearch: { ...complete, sources: 0 } },
      async () => null,
    );

    expect(result.webFoundUnverified).toBeUndefined();
  });
});
