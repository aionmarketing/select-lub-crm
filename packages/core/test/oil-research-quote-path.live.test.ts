/**
 * Test design (testing-strategy) — the quote path meets the runner, on a scratch database
 *
 * SUT: the research runner's tick (`runOilResearchTick`) over ports built here from the real
 *   pipeline pieces — the stored-manual adapter, `gateWebSearch` over the real web-search adapter
 *   with only its search call and page transport faked, and the production extractor dispatch —
 *   together with the quote's two slices, `getQuoteOptions` and `refetchOilResearch`, which queue
 *   the research and read what the run recorded. Every query runs on the real schema in the
 *   rollback harness; nothing reaches a provider or a model.
 *
 * Why here (background-oil-research task 4.2): the quote no longer runs the pipeline, so the
 *   pipeline cases of the former `get-quote-options` suites, `quote-options-manual-reading` and
 *   `quotes-unverified-search-miss` moved to the runner, which now does what the quote did: write
 *   the cache row with its provenance, persist the manual candidates, and remember a completed
 *   miss. Their mapping halves stayed with the slice (`get-quote-options/tests/`).
 *
 * Why a scratch database: a claim takes ANY due row, so rows another suite left in the shared
 *   database would be claimed here.
 *
 * Oracle: `oil-research` (every outcome recorded; a refetch searches whatever the miss window says;
 *   the budget holds only the backfill), `oil-spec-web-search` "A miss is not searched again within
 *   a window", `oil-manual-ingestion` "A manual verifies the quote, cited to its page",
 *   `oil-source-candidates` "Every manual candidate is persisted", oil-quote-liters-pricing D11
 *   (each grade's own source, grouped on the row), and D15/D16 for what the quote then answers.
 *
 * Cells
 *   the cache row          | a verified run writes liters, legend, grades, provenance; a web page's URL,
 *                            tier, class and passage; a fixture's null class and passage; grade sources grouped
 *   candidates             | persisted for a verified and a no-source run, never on the response
 *   stored manual reading  | verifies at tier 1 with no model; not a stated-nothing, another engine's,
 *                            or an unanchored reading; a single unlabelled figure prices and a dry one
 *                            is named, never priced (ingest-harvested-manuals D5)
 *   remembered misses      | a completed search that found nothing; not an extractor failure, a 503, or
 *                            a provider outage; a 404 is definite
 *   refetch                | claimed next with forceWebSearch; a tier 1–3 local source spares the search;
 *                            claimed during the budget pause; a verified refetch adds a row beside the old
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { shouldRunLiveTests, type DbClient } from "@select-lub/core/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/kernel/db.js";
import { getQuoteOptions } from "../src/modules/quotes/get-quote-options/index.js";
import { createOilSpecExtractor, EXTRACTION_FAILED, type AuthoritativeSourceRetriever, type ExtractedOilSpec, type OilSpecExtractor, type RetrieveResult } from "../src/modules/quotes/internal/pipeline/oil-spec.js";
import type { OilResearchPorts } from "../src/modules/quotes/internal/research/ports.js";
import type { SearchCandidate } from "../src/modules/quotes/internal/retrieval/admit.js";
import type { FetchTransport } from "../src/modules/quotes/internal/retrieval/page-fetcher.js";
import { SearchUnavailableError } from "../src/modules/quotes/internal/retrieval/search-fn.js";
import { gateWebSearch, UNVERIFIED_SEARCH_REASON } from "../src/modules/quotes/internal/retrieval/sources.js";
import { createStoredManualRetriever } from "../src/modules/quotes/internal/retrieval/stored-manuals.js";
import { createWebSearchRetriever } from "../src/modules/quotes/internal/retrieval/web-search.js";
import { createPrismaOilQuoteStore } from "../src/modules/quotes/internal/store/prisma.js";
import { refetchOilResearch } from "../src/modules/quotes/refetch-oil-research/index.js";
import { createOutageBreaker, runOilResearchTick } from "../src/modules/quotes/run-oil-research/index.js";
import { seedUnit, withConnectRetry, withTestTransaction } from "../src/testing/index.js";
import { at, MIN, NOW, SETTINGS, TECFIL_OK, trackedDb } from "./oil-research-harness.js";
import { createScratchDatabase, type ScratchDatabase } from "./scratch-database.js";

const hasDatabase = shouldRunLiveTests();
const repoRoot = resolve(import.meta.dirname, "../../..");
const SCRATCH_SETUP_TIMEOUT_MS = 180_000;
const NO_MANUALS = { ...SETTINGS, manualIngestion: false };

type Identity = { make: string; year: number; model: string; version: string };

/** What the fakes saw. */
type Probe = { retrieveOptions: unknown[]; textCalls: number };

/** One ports object over `retrieve` and a text extractor, as the production one is shaped (D21). */
function portsOver(retrieve: AuthoritativeSourceRetriever, text: OilSpecExtractor, probe: Probe): OilResearchPorts {
  return {
    keySet: () => true,
    searchAvailable: () => true,
    specPorts: () => ({
      retrieve: async (identity, options) => {
        probe.retrieveOptions.push(options ?? {});
        return retrieve(identity, options);
      },
      extract: createOilSpecExtractor(async (source, identity) => {
        probe.textCalls += 1;
        return text(source, identity);
      }),
    }),
    tecfil: () => async () => TECFIL_OK,
  };
}

const SPEC: ExtractedOilSpec = { viscosityGrades: ["5W-40"], classification: "", fillLiters: 4.2, fillKind: "em_servico", engineCoverage: "one" };

describe.skipIf(!hasDatabase)("the quote path and the runner — live, on a scratch database", () => {
  let scratch: ScratchDatabase | undefined;
  let prisma!: PrismaClient;

  beforeAll(async () => {
    scratch = await createScratchDatabase(process.env.DATABASE_URL ?? "", "oil_research_quote_path", repoRoot);
    prisma = withConnectRetry(new PrismaClient({ datasourceUrl: scratch.url }));
  }, SCRATCH_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await prisma?.$disconnect();
    } finally {
      await scratch?.drop();
    }
  }, SCRATCH_SETUP_TIMEOUT_MS);

  const inTx = (fn: (tx: DbClient) => Promise<void>) => () => withTestTransaction(prisma, fn);

  /**
   * A unit with a car of a fresh identity, the runner over `ports`, and the quote's two slices on
   * the same transaction.
   */
  async function world(tx: DbClient, ports: (probe: Probe) => OilResearchPorts, settings = SETTINGS, identity: Identity = { make: "Volkswagen", year: 2021, model: "Gol", version: `1.0 ${randomUUID().slice(0, 8)}` }) {
    const unit = await seedUnit(tx);
    const customer = await tx.customer.create({ data: { name: "Ana", unitId: unit.id, origin: "manual", status: "active" }, select: { id: true } });
    const vehicle = await tx.vehicle.create({ data: { customerId: customer.id, origin: "crm", ...identity }, select: { id: true } });
    const db: Db = trackedDb(tx);
    const probe: Probe = { retrieveOptions: [], textCalls: 0 };
    const breaker = createOutageBreaker(settings.outageBreaker);
    const research = ports(probe);
    return {
      identity,
      probe,
      tick: (now = NOW) => runOilResearchTick({ db, ports: research, settings, now: () => now, breaker }, new AbortController().signal),
      open: async (now = NOW) => (await getQuoteOptions(db, { vehicleId: vehicle.id, unitId: unit.id, now }))!,
      refetch: async (now = NOW) => (await refetchOilResearch(db, { vehicleId: vehicle.id, unitId: unit.id, now }))!,
      cacheRows: () => tx.motulCompatibility.findMany({ where: identity, orderBy: { consultedAt: "asc" } }),
      research: () => tx.oilResearch.findFirstOrThrow({ where: { make: identity.make, model: identity.model, version: identity.version } }),
    };
  }

  /** A retriever with one source. */
  const found = (source: Record<string, unknown>): AuthoritativeSourceRetriever => async () => ({ status: "found", sources: [{ publisher: "Volkswagen do Brasil", document: "Manual Gol", page: "p. 287", content: { kind: "text", text: "5W-40, 4,2 L" }, ...source }] }) as RetrieveResult;

  describe("the cache row a verified run writes (formerly the quote's)", () => {
    it("writes the liters, the legend, every grade and the provenance, and the quote then shows them", inTx(async (tx) => {
      const w = await world(tx, (probe) => portsOver(found({}), async () => SPEC, probe));
      await w.open();
      await w.tick();

      const [row] = await w.cacheRows();
      expect(row).toMatchObject({ viscosities: ["5W-40"], fillKind: "em_servico", sourcePublisher: "Volkswagen do Brasil", sourceDocument: "Manual Gol", sourcePage: "p. 287" });
      expect(Number(row!.fillLiters)).toBe(4.2);
      // A local fixture-like source: no document class and no passage on the row.
      expect(row!.sourceClassification).toBeNull();
      expect(row!.sourceExcerpt).toBeNull();
      // The scratch catalog stocks no oil, so the verified row opens on the empty state, with its date.
      expect(await w.open(at(MIN))).toEqual({ status: "empty", viscosityGrades: ["5W-40"], viscosity: "5W-40", classification: "", consultedAt: NOW.toISOString() });
    }));

    it("writes a web page's URL, tier, class and passage, which never reach the answer", inTx(async (tx) => {
      const PASSAGE = "Motor 1.0 — óleo 5W-40 — capacidade em serviço 4,2 L";
      const w = await world(tx, (probe) => portsOver(found({ authority: 1, url: "https://vw.com.br/gol", classification: "manufacturer_manual", excerpt: PASSAGE, content: { kind: "text", text: PASSAGE } }), async () => SPEC, probe));
      await w.open();
      await w.tick();

      const [row] = await w.cacheRows();
      expect(row).toMatchObject({ sourceUrl: "https://vw.com.br/gol", sourceAuthority: 1, sourceClassification: "manufacturer_manual", sourceExcerpt: PASSAGE });
      expect(JSON.stringify(await w.open(at(MIN)))).not.toContain(PASSAGE);
    }));

    it("cites each grade to a source that lists it, grouped by source on the row", inTx(async (tx) => {
      const MANUAL = { publisher: "vw.com.br", document: "Manual Gol", page: "p. 287", authority: 1, url: "https://vw.com.br/m", classification: "manufacturer_manual", excerpt: "5W-40" };
      const CATALOG = { publisher: "carrorac.test", document: "Catálogo", page: "Gol", authority: 5, url: "https://carrorac.test/gol", classification: "aftermarket_catalog", excerpt: "5W-40 ou 5W-30, 4 L com filtro" };
      const two: AuthoritativeSourceRetriever = async () => ({ status: "found", sources: [MANUAL, CATALOG].map((s) => ({ ...s, content: { kind: "text" as const, text: s.excerpt } })) }) as RetrieveResult;
      const w = await world(tx, (probe) =>
        portsOver(two, async (source) => (source.publisher === MANUAL.publisher ? { viscosityGrades: ["5W-40"], classification: "", fillLiters: null, fillKind: null } : { viscosityGrades: ["5W-40", "5W-30"], classification: "", fillLiters: 4, fillKind: "em_servico" }), probe),
      );
      await w.open();
      await w.tick();

      const [row] = await w.cacheRows();
      expect(row!.gradeSources).toEqual({ grades: [{ grades: ["5W-40"], ...MANUAL }, { grades: ["5W-30"], ...CATALOG }], liters: CATALOG });
    }));

    it("persists the manual candidates of a verified and of a no-source run, and keeps them off the answer", inTx(async (tx) => {
      const HARVESTED = { url: "https://www.vw.com.br/dam/gol-2021.pdf", publisher: "vw.com.br", classification: "manufacturer_manual" as const, tier: 1 as const, discoveredVia: "https://www.vw.com.br/manuais.html", label: "Manual Gol 2021", selectionReason: "rótulo nomeia o Gol" };
      const withCandidates = (status: "found" | "none"): AuthoritativeSourceRetriever => async (identity, options) =>
        status === "found" ? { ...((await found({})(identity, options)) as Extract<RetrieveResult, { status: "found" }>), manualCandidates: [HARVESTED] } : { status: "none", manualCandidates: [HARVESTED] };
      for (const status of ["found", "none"] as const) {
        const w = await world(tx, (probe) => portsOver(withCandidates(status), async () => SPEC, probe), NO_MANUALS);
        await w.open();
        await w.tick();

        const rows = await tx.oilSourceCandidate.findMany({ where: w.identity, select: { url: true, label: true, selectionReason: true, discoveredVia: true } });
        expect(rows).toEqual([{ url: HARVESTED.url, label: HARVESTED.label, selectionReason: HARVESTED.selectionReason, discoveredVia: HARVESTED.discoveredVia }]);
        expect(JSON.stringify(await w.open(at(MIN)))).not.toContain(HARVESTED.url);
      }
    }));

    it("records no source when no adapter holds a document, and the quote says so", inTx(async (tx) => {
      const w = await world(tx, (probe) => portsOver(async () => ({ status: "none" }), async () => null, probe), NO_MANUALS);
      await w.open();
      await w.tick();

      expect(await w.research()).toMatchObject({ state: "no_spec", searched: true });
      expect(await w.open(at(MIN))).toEqual({ status: "no_spec", reason: "no_source" });
    }));
  });

  describe("a stored manual reading as the source (formerly quote-options-manual-reading)", () => {
    const EXCERPT = "Óleo do motor: SAE 5W-40\nCapacidade com filtro: 4,0 litros";

    /** The car's world, with a stored reading of its manual (for `readFor`'s identity when given). */
    async function withReading(tx: DbClient, status: "verified" | "stated_nothing" = "verified", readFor?: { version: string }, specChanges: Record<string, unknown> = {}) {
      const text = vi.fn<OilSpecExtractor>(async () => {
        throw new Error("a model was called for a stored manual reading");
      });
      const w = await world(tx, (probe) => portsOver(createStoredManualRetriever(createPrismaOilQuoteStore(tx)), text, probe), NO_MANUALS);
      const url = `https://www.vw.com.br/manuais/gol-2021-${randomUUID().slice(0, 8)}.pdf`;
      await tx.oilManualIngestion.create({ data: { url, state: "ingested", attempts: 1 } });
      await tx.oilManualReading.create({
        data: {
          url,
          ...w.identity,
          ...(readFor ?? {}),
          status,
          citedPage: "p. 3",
          excerpt: EXCERPT,
          readAt: at(-MIN),
          spec: { viscosityGrades: ["5W-40"], classification: "", fillLiters: 4, fillKind: "em_servico", engineCoverage: "one", enginesNamed: [], publisher: "vw.com.br", document: "Manual Gol 2021", sourceClass: "manufacturer_manual", ...specChanges },
        },
      });
      await w.open();
      await w.tick();
      return { ...w, url, text };
    }

    it("verifies cited to the manual's page at tier 1, with no model, keeping the passage on the row", inTx(async (tx) => {
      const w = await withReading(tx);

      const [row] = await w.cacheRows();
      expect({ ...row, fillLiters: Number(row!.fillLiters) }).toMatchObject({ viscosities: ["5W-40"], fillLiters: 4, sourcePublisher: "vw.com.br", sourceDocument: "Manual Gol 2021", sourcePage: "p. 3", sourceUrl: w.url, sourceAuthority: 1, sourceClassification: "manufacturer_manual", sourceExcerpt: EXCERPT });
      expect(w.text).not.toHaveBeenCalled();
    }));

    it("does not use a reading that stated nothing", inTx(async (tx) => {
      const w = await withReading(tx, "stated_nothing");
      expect(await w.cacheRows()).toEqual([]);
      expect((await w.research()).state).toBe("no_spec");
    }));

    it("does not use another engine's reading of the same manual", inTx(async (tx) => {
      const w = await withReading(tx, "verified", { version: "1.6 MSI" });
      expect(await w.cacheRows()).toEqual([]);
    }));

    // ingest-harvested-manuals D5 (the owner, 2026-09-26) replaced #182's interim in-service-only
    // rule: a single unlabelled figure prices, shown as unlabelled; a dry one never prices.
    it("prices a single unlabelled figure, recorded as unlabelled", inTx(async (tx) => {
      const w = await withReading(tx, "verified", undefined, { fillKind: "unlabeled", fillCondition: "unlabeled" });

      const [row] = await w.cacheRows();
      expect({ fillLiters: Number(row!.fillLiters), fillKind: row!.fillKind, fillCondition: row!.fillCondition, unusableFillLiters: row!.unusableFillLiters }).toEqual({
        fillLiters: 4,
        fillKind: "unlabeled",
        fillCondition: "unlabeled",
        unusableFillLiters: null,
      });
      // The quote maps the stored type: its options carry "unlabeled", for the card's caption.
      await tx.catalogItem.create({
        data: { id: `oil-${randomUUID().slice(0, 8)}`, brand: "Motul", description: "8100 X-cess", price: 50, stock: 10, active: true, lubricant: { create: { viscosity: "5W-40", classification: "" } } },
      });
      expect(await w.open(at(MIN))).toMatchObject({ status: "options", fillLiters: 4, fillKind: "unlabeled", fillCondition: "unlabeled" });
    }));

    it("verifies no capacity for a dry figure, names it, and keeps it on the row", inTx(async (tx) => {
      const w = await withReading(tx, "verified", undefined, { fillKind: null, fillCondition: "dry" });
      // A stocked grade: a missing volume with no card to price answers empty (background-oil-research D24).
      await tx.catalogItem.create({
        data: { id: `oil-${randomUUID().slice(0, 8)}`, brand: "Motul", description: "8100 X-cess", price: 50, stock: 10, active: true, lubricant: { create: { viscosity: "5W-40", classification: "" } } },
      });

      expect(await w.open(at(MIN))).toMatchObject({ status: "no_capacity", viscosityGrades: ["5W-40"], unusableFill: { liters: 4, condition: "dry" } });
      const [row] = await w.cacheRows();
      expect({ fillLiters: row!.fillLiters, fillCondition: row!.fillCondition, unusableFillLiters: Number(row!.unusableFillLiters) }).toEqual({
        fillLiters: null,
        fillCondition: "dry",
        unusableFillLiters: 4,
      });
    }));

    it("keeps the capacity type of in-service liters on the row", inTx(async (tx) => {
      const w = await withReading(tx);

      const [row] = await w.cacheRows();
      expect({ fillCondition: row!.fillCondition, unusableFillLiters: row!.unusableFillLiters }).toEqual({ fillCondition: "with_filter", unusableFillLiters: null });
    }));

    it("does not use a reading whose values are not in its passage", inTx(async (tx) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const w = await withReading(tx, "verified", undefined, { viscosityGrades: ["0W-20"] });
        expect(await w.cacheRows()).toEqual([]);
        expect(warn).toHaveBeenCalledWith("manual-reading", expect.stringContaining("unanchored"));
      } finally {
        warn.mockRestore();
      }
    }));
  });

  describe("which searches are remembered as a miss (formerly quotes-unverified-search-miss)", () => {
    const MANUALS_PAGE = "https://servicos.fiat.com.br/manuais.html";
    const BROKEN_PAGE = "https://servicos.fiat.com.br/argo-ficha.html";
    const GONE_PAGE = "https://servicos.fiat.com.br/argo-antigo.html";
    const LINKED_PDF = "https://servicos.fiat.com.br/content/dam/fiat/manual/argo-2021.pdf";
    const hit = (url: string): SearchCandidate => ({ url, classification: "manufacturer_manual", reason: "página da montadora", title: "Fiat" });

    /** The manuals page reads (and states no oil); the PDF is a document; one page 503, one 404. */
    const transport = (async (url: string, init: { method: "GET" | "HEAD" }) => {
      const type = url.endsWith(".pdf") ? "application/pdf" : "text/html";
      if (url.endsWith("/robots.txt")) return { status: 404, headers: { get: () => null }, text: async () => "" };
      if (url === BROKEN_PAGE) return { status: 503, headers: { get: () => type }, text: async () => "" };
      if (url === GONE_PAGE) return { status: 404, headers: { get: () => type }, text: async () => "" };
      if (init.method === "HEAD") return { status: 200, headers: { get: () => type }, text: async () => "" };
      return { status: 200, headers: { get: () => type }, text: async () => "<html><title>Manuais Fiat</title><body>Baixe o manual do seu Fiat Argo. Consulte a rede.</body></html>" };
    }) as unknown as FetchTransport;

    /** An Argo whose only retriever is the gated web search over `search`, and its misses. */
    async function argo(tx: DbClient, search: () => Promise<SearchCandidate[]>, text: OilSpecExtractor) {
      const store = createPrismaOilQuoteStore(tx);
      const web = createWebSearchRetriever({ search, transport, log: () => {}, now: () => NOW.getTime() });
      const retrieve = gateWebSearch(async () => ({ status: "none" }), web, store, () => NOW.getTime());
      const w = await world(tx, (probe) => portsOver(retrieve, text, probe), NO_MANUALS, { make: "Fiat", year: 2021, model: "Argo", version: `1.0 Firefly ${randomUUID().slice(0, 8)}` });
      const misses = () => tx.oilSpecSearchMiss.findMany({ where: w.identity, select: { reason: true, searchedAt: true } });
      return { ...w, store, misses };
    }
    const statesNothing: OilSpecExtractor = async () => null;

    it("remembers a page read that stated nothing; a quote-open then does not search, a refetch does", inTx(async (tx) => {
      const search = vi.fn(async () => [hit(MANUALS_PAGE), hit(LINKED_PDF)]);
      const w = await argo(tx, search, statesNothing);
      await w.open();
      await w.tick();

      expect(await w.research()).toMatchObject({ state: "no_spec" });
      expect(await w.misses()).toEqual([{ reason: UNVERIFIED_SEARCH_REASON, searchedAt: NOW }]);
      expect((await w.store.listSourceCandidates(w.identity)).map((c) => c.url)).toEqual([LINKED_PDF]);

      await w.open(at(MIN));
      expect((await w.tick(at(MIN))).outcome).toBe("idle");
      expect(search).toHaveBeenCalledTimes(1);

      await w.refetch(at(2 * MIN));
      await w.tick(at(2 * MIN));
      expect(search).toHaveBeenCalledTimes(2);
    }));

    for (const [name, pages, text] of [
      ["an extractor that fails is not a page that stated nothing", [MANUALS_PAGE], async () => EXTRACTION_FAILED],
      ["a page that answered 503 leaves the search incomplete", [MANUALS_PAGE, BROKEN_PAGE], statesNothing],
    ] as const) {
      it(`${name}: no miss, and the retry searches again`, inTx(async (tx) => {
        const search = vi.fn(async () => pages.map(hit));
        const w = await argo(tx, search, text as OilSpecExtractor);
        await w.open();
        await w.tick();

        expect(await w.research()).toMatchObject({ state: "queued", attempts: 1, dueAt: at(5 * MIN) });
        expect(await w.misses()).toEqual([]);
        await w.tick(at(5 * MIN));
        expect(search).toHaveBeenCalledTimes(2);
      }));
    }

    it("a page that answered 404 is a definite answer: the search is complete, a miss", inTx(async (tx) => {
      const search = vi.fn(async () => [hit(MANUALS_PAGE), hit(GONE_PAGE)]);
      const w = await argo(tx, search, statesNothing);
      await w.open();
      await w.tick();

      expect(await w.research()).toMatchObject({ state: "no_spec" });
      expect(await w.misses()).toEqual([{ reason: UNVERIFIED_SEARCH_REASON, searchedAt: NOW }]);
    }));

    it("a search provider that fails is an outage: retried, then failed, no miss, and the quote says it failed", inTx(async (tx) => {
      const search = vi.fn(async (): Promise<SearchCandidate[]> => {
        throw new SearchUnavailableError("search tool call failed");
      });
      const w = await argo(tx, search, statesNothing);
      await w.open();
      for (const when of [NOW, at(5 * MIN), at(20 * MIN)]) await w.tick(when);

      expect(await w.research()).toMatchObject({ state: "failed" });
      expect(search).toHaveBeenCalledTimes(3);
      expect(await w.misses()).toEqual([]);
      expect(await w.open(at(21 * MIN))).toEqual({ status: "error" });
    }));
  });

  describe("Buscar novamente meets the runner (D16)", () => {
    it("is claimed next and searches the web whatever the miss window says", inTx(async (tx) => {
      const w = await world(tx, (probe) => portsOver(found({}), async () => SPEC, probe));
      await w.open();
      await w.tick();
      expect(w.probe.retrieveOptions).toEqual([{ forceWebSearch: false }]);

      expect(await w.refetch(at(MIN))).toMatchObject({ refresh: { queuePosition: 0 } });
      await w.tick(at(MIN));

      expect(w.probe.retrieveOptions[1]).toEqual({ forceWebSearch: true });
      // A verified refetch adds a new row beside the earlier one, and the quote shows the new one.
      const rows = await w.cacheRows();
      expect(rows.map((row) => row.consultedAt)).toEqual([NOW, at(MIN)]);
      expect(await w.open(at(2 * MIN))).toMatchObject({ consultedAt: at(MIN).toISOString() });
    }));

    it("is spared the search by a tier 1–3 local source, as the gate says", inTx(async (tx) => {
      const search = vi.fn(async (): Promise<SearchCandidate[]> => []);
      const store = createPrismaOilQuoteStore(tx);
      const web = createWebSearchRetriever({ search, transport: (async () => ({ status: 404, headers: { get: () => null }, text: async () => "" })) as unknown as FetchTransport, log: () => {}, now: () => NOW.getTime() });
      const local = found({ authority: 1 });
      const w = await world(tx, (probe) => portsOver(gateWebSearch(local, web, store, () => NOW.getTime()), async () => SPEC, probe));

      await w.refetch();
      await w.tick();

      expect(w.probe.retrieveOptions).toEqual([{ forceWebSearch: true }]);
      expect(search).not.toHaveBeenCalled();
      expect((await w.research()).state).toBe("verified");
    }));

    it("is claimed at the next tick while the backfill is paused by the budget", inTx(async (tx) => {
      const w = await world(tx, (probe) => portsOver(found({}), async () => SPEC, probe));
      // The day's spend is at the budget: only the backfill is held.
      await tx.oilResearchRun.create({ data: { id: randomUUID(), identityKey: "spent", kind: "full", trigger: "backfill", path: "search", startedAt: at(-60 * MIN), finishedAt: at(-59 * MIN), outcome: "verified", costUsd: 2 } });
      // A tick with nothing due writes the heartbeat, which records the budget pause.
      expect((await w.tick(at(-MIN))).outcome).toBe("idle");
      expect(await tx.oilResearchRunner.findUniqueOrThrow({ where: { id: "runner" } })).toMatchObject({ pausedReason: "budget" });

      expect(await w.refetch()).toMatchObject({ status: "researching", paused: null });
      expect((await w.tick()).outcome).toBe("research");
      expect(await w.open(at(MIN))).toMatchObject({ status: "empty", consultedAt: NOW.toISOString() });
    }));
  });
});
