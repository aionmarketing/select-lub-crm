/**
 * Test design (testing-strategy) — what the web adapter admits and records (oil-research-web-retrieval D2, D3)
 *
 * SUT: createWebSearchRetriever with an injected search, transport and log, and `chooseManuals`
 * for the agreement between recording and queueing.
 *
 * Oracle: specs/quotes/oil-spec-web-search "The searching model classifies each page and that
 * classification sets its tier" (a bare site root is rejected and spends nothing) and "Only HTML
 * text is extracted; documents are recorded as manual candidates" (a document is recorded only
 * when it concerns the vehicle, with the search title as its label); specs/quotes/oil-source-
 * candidates "Every manual candidate is persisted, not counted".
 *
 * Axes
 *   R1 result kind — site root / deeper page
 *   R2 document — names the model in the title / only in the URL / in neither
 *   R3 gateway link — names the model in its label / in its URL / in neither
 *
 * Sampled cells (one row per `it`)
 *   roots beside a real page  | R1    | the roots are never requested, spend no attempt, and the real
 *      page is read under a read cap of one
 *   PDF titled with the model | R2    | recorded, the title is its label, `chooseManuals` queues it
 *      even though its URL is cryptic (Honda's `AT7A2121OM.PDF`)
 *   PDF named only in the URL | R2    | recorded with NO label (a generic title such as "Download" is no label),
 *      and `chooseManuals` queues it: the URL decides for an unlabelled document, as it does at recording
 *   price list, promotion     | R2    | not recorded, named in the pass log; the log's count of
 *      candidates equals the recorded ones
 *   gateway links             | R3    | the related one is recorded and queued; the price list and the promotion's
 *      terms are not, and one summary line says how many were left out
 *   link labelled "manual"    | R3    | NOT recorded though its URL names the model: a label decides, as it does when
 *      the manual is queued (Q5), so nothing is recorded that could never be read
 *   unlabelled link, URL names it | R3 | recorded and queued
 *
 * Out of scope: the rule itself (model-named.test.ts), the root rule in isolation (admit.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseManuals } from "../manuals/select-candidates.js";
import type { SearchCandidate } from "./admit.js";
import type { FetchTransport } from "./page-fetcher.js";
import { createWebSearchRetriever, type WebSearchLog } from "./web-search.js";
import type { ManualCandidate } from "../pipeline/oil-spec.js";
import type { VehicleIdentity } from "../store/store.js";

const identity: VehicleIdentity = { make: "Hyundai", year: 2022, model: "HB20", version: "1.0 12V Flex" };

afterEach(() => {
  delete process.env.WEB_SEARCH_MAX_FETCHES;
  delete process.env.WEB_SEARCH_MAX_ATTEMPTS;
});

function hit(url: string, title: string, classification = "manufacturer_manual"): SearchCandidate {
  return { url, classification, reason: "r", title };
}

/** Serves HTML for `pages` (a body per URL), a PDF for any `.pdf`, and records every request. */
function serving(pages: Record<string, string>) {
  const requested: string[] = [];
  const transport = vi.fn(async (url: string, init: { method: "GET" | "HEAD" }) => {
    requested.push(`${init.method} ${url}`);
    if (url.endsWith("/robots.txt")) {
      return { status: 404, headers: { get: () => null }, text: async (): Promise<string> => "" };
    }
    const type = /\.pdf$/i.test(url) ? "application/pdf" : "text/html";
    return {
      status: 200,
      headers: { get: () => type },
      text: async (): Promise<string> => (init.method === "HEAD" ? "" : (pages[url] ?? "<html><title>T</title><body>HB20</body></html>")),
    };
  }) as unknown as FetchTransport;
  return { transport, requested };
}

/** What the manual pipeline would queue from the candidates a search recorded: the invariant is recorded implies queueable. */
function queuedFrom(result: { manualCandidates?: ManualCandidate[] }): string[] {
  const rows = (result.manualCandidates ?? []).map((c) => ({ url: c.url, label: c.label ?? null, classification: c.classification, tier: c.tier, foundAt: new Date(0) }));
  return chooseManuals(rows, identity, 2);
}

async function run(hits: SearchCandidate[], transport: FetchTransport) {
  const entries: WebSearchLog[] = [];
  const result = await createWebSearchRetriever({ search: async () => hits, transport, log: (e) => entries.push(e) })(identity);
  return { result, entries };
}

describe("site roots", () => {
  it("never requests a root, spends no attempt on it, and still reads the real page", async () => {
    process.env.WEB_SEARCH_MAX_FETCHES = "1";
    process.env.WEB_SEARCH_MAX_ATTEMPTS = "1";
    const { transport, requested } = serving({});
    const real = "https://www.hyundai.com.br/hb20/manual.html";

    const { result, entries } = await run(
      [hit("https://www.chevrolet.com.br", "Chevrolet"), hit("https://www.chevroletvalledorado.mx/", "Chevrolet"), hit(real, "HB20")],
      transport,
    );

    expect(result).toMatchObject({ status: "found", sources: [{ url: real }] });
    expect(result).not.toHaveProperty("unreadAdmitted");
    expect(requested.some((r) => r.includes("chevrolet"))).toBe(false);
    const outcomes = entries[0]!.passes[0]!.candidates.map((c) => c.outcome);
    expect(outcomes.filter((o) => o === "rejected: site root")).toHaveLength(2);
  });
});

describe("a document is recorded only when it concerns the vehicle", () => {
  const MANUAL = "https://www.hyundai.com.br/dam/AT7A2121OM.PDF";
  const NAMED_IN_URL = "https://www.hyundai.com.br/dam/manual-hb20-2022.pdf";
  const PRICES = "https://www.hyundai.com.br/dam/tabela-de-precos-out.pdf";
  const PROMO = "https://www.hyundai.com.br/dam/regulamento-promocao-tiktok.pdf";

  it("records a PDF titled with the model, with the title as its label, and chooseManuals queues it", async () => {
    const { transport } = serving({});

    const { result, entries } = await run([hit(MANUAL, "Manual do Proprietário HB20 2022 - Hyundai")], transport);

    if (result.status !== "none") throw new Error("expected none");
    expect(result.manualCandidates).toEqual([
      {
        url: MANUAL,
        publisher: "hyundai.com.br",
        classification: "manufacturer_manual",
        tier: 1,
        label: "Manual do Proprietário HB20 2022 - Hyundai",
      },
    ]);
    expect(entries[0]!.manualCandidates).toBe(1);
    // Recording and queueing judge the same text: the recorded lead is one the manual pipeline can read.
    const queued = chooseManuals(
      result.manualCandidates!.map((c) => ({ url: c.url, label: c.label ?? null, classification: c.classification, tier: c.tier, foundAt: new Date(0) })),
      identity,
      2,
    );
    expect(queued).toEqual([MANUAL]);
  });

  it("records a PDF that names the model only in its URL, unlabelled, and chooseManuals queues it", async () => {
    const { transport } = serving({});

    const { result } = await run([hit(NAMED_IN_URL, "Download")], transport);

    // "Download" names no model, so it is no label: the URL decides, here and when the manual is queued.
    expect(result).toMatchObject({ status: "none", manualCandidates: [{ url: NAMED_IN_URL, label: null }] });
    expect(queuedFrom(result as { manualCandidates?: ManualCandidate[] })).toEqual([NAMED_IN_URL]);
  });

  it("records a PDF whose title and URL both name the model, with the title as its label", async () => {
    const { transport } = serving({});

    const { result } = await run([hit(NAMED_IN_URL, "Manual HB 20 2022")], transport);

    expect(result).toMatchObject({ status: "none", manualCandidates: [{ url: NAMED_IN_URL, label: "Manual HB 20 2022" }] });
    expect(queuedFrom(result as { manualCandidates?: ManualCandidate[] })).toEqual([NAMED_IN_URL]);
  });

  it("does not record a price list or a promotion's terms the model called manuals, and says so in the log", async () => {
    const { transport } = serving({});

    const { result, entries } = await run(
      [hit(PRICES, "Tabela de preços outubro"), hit(PROMO, "Regulamento da promoção TikTok"), hit(MANUAL, "Manual HB20")],
      transport,
    );

    if (result.status !== "none") throw new Error("expected none");
    expect(result.manualCandidates?.map((c) => c.url)).toEqual([MANUAL]);
    expect(entries[0]!.manualCandidates).toBe(1);
    const outcomes = Object.fromEntries(entries[0]!.passes[0]!.candidates.map((c) => [c.url, c.outcome]));
    expect(outcomes[PRICES]).toBe("document, not about this vehicle");
    expect(outcomes[PROMO]).toBe("document, not about this vehicle");
  });
});

describe("a gateway page's links are recorded only when they concern the vehicle", () => {
  const GATEWAY = "https://www.hyundai.com.br/pt/manuais.html";

  it("keeps the HB20 manual and leaves out the price list and the promotion's terms", async () => {
    const body =
      "<html><title>Manuais</title><body>" +
      '<a href="https://www.hyundai.com.br/dam/a1.pdf">Manual do Proprietário HB20 2022</a>' +
      '<a href="https://www.hyundai.com.br/dam/a2.pdf">Tabela de preços</a>' +
      '<a href="https://www.hyundai.com.br/dam/a3.pdf">Termos da promoção</a>' +
      "</body></html>";
    const { transport } = serving({ [GATEWAY]: body });

    const { result, entries } = await run([hit(GATEWAY, "Manuais")], transport);

    if (result.status !== "found") throw new Error("expected found");
    expect(result.manualCandidates).toEqual([
      {
        url: "https://www.hyundai.com.br/dam/a1.pdf",
        publisher: "hyundai.com.br",
        classification: "manufacturer_manual",
        tier: 1,
        discoveredVia: GATEWAY,
        label: "Manual do Proprietário HB20 2022",
        selectionReason: null,
      },
    ]);
    expect(entries[0]!.manualCandidates).toBe(1);
    expect(entries[0]!.passes[0]!.candidates.map((c) => c.outcome)).toContain("2 linked documents not about this vehicle");
    expect(queuedFrom(result)).toEqual(["https://www.hyundai.com.br/dam/a1.pdf"]);
  });

  it("does not record a link labelled \"manual\" though its URL names the model: a label decides, as at queueing", async () => {
    const body = '<html><title>Manuais</title><body><a href="https://www.hyundai.com.br/dam/hb20-2022.pdf">manual</a></body></html>';
    const { transport } = serving({ [GATEWAY]: body });

    const { result } = await run([hit(GATEWAY, "Manuais")], transport);

    expect(result).toMatchObject({ status: "found" });
    expect((result as { manualCandidates?: unknown[] }).manualCandidates ?? []).toEqual([]);
  });

  it("records an unlabelled link whose URL names the model, and chooseManuals queues it", async () => {
    const url = "https://www.hyundai.com.br/dam/hb20-2022.pdf";
    const body = `<html><title>Manuais</title><body><a href="${url}"></a></body></html>`;
    const { transport } = serving({ [GATEWAY]: body });

    const { result } = await run([hit(GATEWAY, "Manuais")], transport);

    expect(result).toMatchObject({ status: "found", manualCandidates: [{ url, label: null }] });
    expect(queuedFrom(result as { manualCandidates?: ManualCandidate[] })).toEqual([url]);
  });
});
