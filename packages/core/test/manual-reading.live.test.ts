/**
 * Test design (testing-strategy) — reading a stored manual once per identity, on a scratch database
 *
 * SUT: `readNextManual` (slice `quotes/read-manuals`) over the real reading store, with fake
 *   passage selectors and extractors (no model), and `listManualReadings`, what a quote reads.
 *   A scratch database of its own, like the ingestion tests, because a tick claims ANY due
 *   reading; each case also rolls back.
 *
 * Oracle: ingest-harvested-manuals D7 and oil-manual-ingestion:
 *   - a reading of an ingested manual reads its stored pages (no download), and stores the
 *     extraction cited to its page, with the document it read;
 *   - "Two identities share one manual: one download, two readings";
 *   - a manual that stated nothing is not read again (4.4);
 *   - a model failure is retried later, and after three attempts is a definite `failed`
 *     (review of #182: bounded by a count, not by the queue's age);
 *   - the lease: a reading abandoned mid-read is claimed again, or failed if that was its last
 *     attempt; a stale write changes nothing (the repo's compare-and-set rule, review of #181);
 *   - without OPENAI_API_KEY the job claims nothing, so readings keep their attempts;
 *   - the kill switch stops reading too;
 *   - a quote sees the identity's verified readings, and only those.
 */
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { shouldRunLiveTests } from "@select-lub/core/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type DbClient } from "../src/kernel/db.js";
import { MANUAL_READING_MAX_ATTEMPTS, MANUAL_READING_RETRY_MS, claimNextReading, recordReading } from "../src/modules/quotes/internal/manuals/reading-store.js";
import { EXTRACTION_FAILED, type ExtractedOilSpec, type OilSpecExtractor } from "../src/modules/quotes/internal/pipeline/oil-spec.js";
import { manualReadings } from "../src/modules/quotes/internal/store/manual-readings.js";
import { readNextManual } from "../src/modules/quotes/read-manuals/index.js";
import { runInTransactionOnTx, withConnectRetry, withTestTransaction } from "../src/testing/index.js";
import { createScratchDatabase, type ScratchDatabase } from "./scratch-database.js";

const hasDatabase = shouldRunLiveTests();
const repoRoot = resolve(import.meta.dirname, "../../..");
const SCRATCH_SETUP_TIMEOUT_MS = 180_000;
const GOL_2021 = "https://www.vw.com.br/manuais/gol-2021.pdf";
const NOW = new Date("2026-09-26T12:00:00.000Z");
const GOL_10 = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0 FLEX 12V 4P" };
const GOL_16 = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.6 MSI" };
const SPEC: ExtractedOilSpec = { viscosityGrades: ["5W-40"], classification: "", fillLiters: 4, fillKind: "em_servico", engineCoverage: "one", enginesNamed: [] };
const PAGES = [
  "Manual do Proprietário",
  "Índice",
  "Capacidades — Motor 1.0 12V\nÓleo do motor: SAE 5W-40\nCapacidade com filtro: 4,0 litros",
  "Capacidades — Motor 1.6 MSI\nÓleo do motor: SAE 5W-40\nCapacidade com filtro: 4,5 litros",
];

/** An ingested manual: its candidate, its ingestion row, one document and its pages. */
async function ingested(tx: DbClient, identities = [GOL_10]): Promise<string> {
  for (const identity of identities) {
    await tx.oilSourceCandidate.create({
      data: { ...identity, url: GOL_2021, publisher: "vw.com.br", classification: "manufacturer_manual", tier: 1, label: "Manual Gol 2021", foundAt: NOW },
    });
  }
  await tx.oilManualIngestion.create({ data: { url: GOL_2021, state: "ingested", attempts: 1 } });
  const document = await tx.oilManualDocument.create({
    data: { url: GOL_2021, sha256: "a".repeat(64), bytes: 1000, pages: PAGES.length, fetchedAt: NOW, fetchMs: 1, parseMs: 1 },
  });
  await tx.oilManualPage.createMany({ data: PAGES.map((text, i) => ({ documentId: document.id, pageNumber: i + 1, text })) });
  for (const identity of identities) await tx.oilManualReading.create({ data: { url: GOL_2021, ...identity } });
  return document.id;
}

/** Extracts per identity, as a model reading that identity's passage would. */
const extractFor: OilSpecExtractor = async (source) => {
  const text = source.content.kind === "text" ? source.content.text : "";
  return text.includes("4,5 litros") && !text.includes("4,0 litros") ? { ...SPEC, fillLiters: 4.5 } : SPEC;
};

describe.skipIf(!hasDatabase)("quotes/read-manuals — live, on a scratch database", () => {
  let scratch: ScratchDatabase | undefined;
  let prisma!: PrismaClient;

  beforeAll(async () => {
    scratch = await createScratchDatabase(process.env.DATABASE_URL ?? "", "manual_reading", repoRoot);
    prisma = withConnectRetry(new PrismaClient({ datasourceUrl: scratch.url }));
  }, SCRATCH_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await prisma?.$disconnect();
    } finally {
      await scratch?.drop();
    }
  }, SCRATCH_SETUP_TIMEOUT_MS);

  const openaiKey = process.env.OPENAI_API_KEY;
  afterEach(() => {
    delete process.env.MANUAL_INGESTION_ENABLED;
    if (openaiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = openaiKey;
    vi.restoreAllMocks();
  });

  const inTx = (fn: (tx: DbClient) => Promise<void>) => () => withTestTransaction(prisma, fn);
  const tick = (tx: DbClient, extract: OilSpecExtractor = extractFor, at: Date = NOW) => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    // No selector: the located pages are read whole, and the fake extractor reads them.
    return readNextManual({ db: createDb(tx, runInTransactionOnTx(tx)), extract, selectPassage: async () => ({ status: "unavailable" }), now: () => at, readBy: "fake-model" });
  };
  const reading = (tx: DbClient, version = GOL_10.version) =>
    tx.oilManualReading.findFirstOrThrow({ where: { url: GOL_2021, version }, select: { status: true, documentId: true, citedPage: true, excerpt: true, spec: true, readBy: true, readAt: true } });

  it("reads the stored pages, and stores the extraction cited to its page, with the document it read", inTx(async (tx) => {
    const documentId = await ingested(tx);

    const result = await tick(tx);

    expect(result).toMatchObject({ outcome: "verified", citedPage: "pp. 3–4" });
    const row = await reading(tx);
    expect(row).toMatchObject({ status: "verified", documentId, citedPage: "pp. 3–4", readBy: "fake-model", readAt: NOW });
    expect(row.excerpt).toContain("Capacidade com filtro: 4,0 litros");
    expect(row.spec).toEqual({ ...SPEC, publisher: "vw.com.br", document: "Manual Gol 2021", sourceClass: "manufacturer_manual" });
    expect(await tick(tx)).toMatchObject({ outcome: "idle" });
  }));

  it("gives two identities sharing one manual two readings of the one document", inTx(async (tx) => {
    const documentId = await ingested(tx, [GOL_10, GOL_16]);

    await tick(tx);
    await tick(tx);

    expect(await tx.oilManualDocument.count()).toBe(1);
    expect(await reading(tx, GOL_10.version)).toMatchObject({ status: "verified", documentId });
    expect(await reading(tx, GOL_16.version)).toMatchObject({ status: "verified", documentId });
  }));

  it("does not read a manual that stated nothing again", inTx(async (tx) => {
    await ingested(tx);
    const nothing = vi.fn<OilSpecExtractor>(async () => null);

    expect(await tick(tx, nothing)).toMatchObject({ outcome: "stated_nothing" });
    expect(await tick(tx, nothing, new Date(NOW.getTime() + 30 * 24 * 60 * 60_000))).toMatchObject({ outcome: "idle" });
    expect(nothing).toHaveBeenCalledTimes(1);
  }));

  it("retries a model failure after its interval, and fails it for good after three attempts", inTx(async (tx) => {
    await ingested(tx);
    const later = (retries: number, ms = 0) => new Date(NOW.getTime() + retries * MANUAL_READING_RETRY_MS + ms);
    const failing = async () => EXTRACTION_FAILED;

    expect(await tick(tx, failing)).toMatchObject({ outcome: "failed" });
    expect(await reading(tx)).toMatchObject({ status: "failed", spec: null, citedPage: null });
    expect(await tick(tx, extractFor, later(1, -1))).toMatchObject({ outcome: "idle" });
    expect(await tick(tx, failing, later(1))).toMatchObject({ outcome: "failed" });
    expect(await tick(tx, failing, later(2))).toMatchObject({ outcome: "failed" });
    expect(MANUAL_READING_MAX_ATTEMPTS).toBe(3);
    // Three attempts spent: however long it waits, it is not claimed again.
    expect(await tick(tx, extractFor, later(100))).toMatchObject({ outcome: "idle" });
    expect(await tx.oilManualReading.findFirstOrThrow({ select: { attempts: true, status: true } })).toEqual({ attempts: 3, status: "failed" });
  }));

  it("fails a reading whose lease ran out on its last attempt, instead of claiming it again", inTx(async (tx) => {
    await ingested(tx);
    await tx.oilManualReading.updateMany({ data: { status: "reading", attempts: MANUAL_READING_MAX_ATTEMPTS, readAt: new Date(NOW.getTime() - 60 * 60_000) } });
    const extract = vi.fn<OilSpecExtractor>(async () => SPEC);

    expect(await tick(tx, extract)).toMatchObject({ outcome: "idle" });
    expect(await reading(tx)).toMatchObject({ status: "failed" });
    expect(extract).not.toHaveBeenCalled();
  }));

  it("claims nothing without OPENAI_API_KEY, so the reading keeps its attempts", inTx(async (tx) => {
    await ingested(tx);
    delete process.env.OPENAI_API_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // The production ports: nothing injected.
    expect(await readNextManual({ db: createDb(tx, runInTransactionOnTx(tx)), now: () => NOW })).toEqual({ readingId: null, outcome: "no_key" });
    expect(await tx.oilManualReading.findFirstOrThrow({ select: { attempts: true, status: true } })).toEqual({ attempts: 0, status: "pending" });
  }));

  it("does not read a manual that is not ingested yet", inTx(async (tx) => {
    await ingested(tx);
    await tx.oilManualIngestion.update({ where: { url: GOL_2021 }, data: { state: "pending" } });

    expect(await tick(tx)).toMatchObject({ outcome: "idle" });
  }));

  it("claims a reading abandoned mid-read again after its lease, and a stale write changes nothing", inTx(async (tx) => {
    await ingested(tx);
    const stale = await claimNextReading(tx, NOW, 60_000);
    const fresh = await claimNextReading(tx, new Date(NOW.getTime() + 60_001), 60_000);
    expect(stale).not.toBeNull();
    expect(fresh?.id).toBe(stale?.id);

    expect(fresh?.attempts).toBe(2);
    expect(await recordReading(tx, stale!, null, { status: "failed", why: "late" }, "fake-model", NOW)).toBe(false);
    expect(await reading(tx)).toMatchObject({ status: "reading", readAt: fresh!.readAt });
    expect(await recordReading(tx, fresh!, null, { status: "stated_nothing", why: "x", citedPage: null, excerpt: null, spec: null }, "fake-model", NOW)).toBe(true);
  }));

  it("does nothing when switched off", inTx(async (tx) => {
    await ingested(tx);
    process.env.MANUAL_INGESTION_ENABLED = "false";

    expect(await tick(tx)).toEqual({ readingId: null, outcome: "off" });
    expect(await reading(tx)).toMatchObject({ status: "pending" });
  }));

  it("hands a quote the identity's verified readings, and only those", inTx(async (tx) => {
    await ingested(tx, [GOL_10, GOL_16]);
    await tick(tx);
    await tick(tx, async () => null);

    const readings = await manualReadings(tx).listManualReadings({ ...GOL_10, version: "1.0 flex 12v 4p" });
    expect(readings).toEqual([
      {
        url: GOL_2021,
        citedPage: "pp. 3–4",
        excerpt: expect.stringContaining("4,0 litros"),
        spec: { ...SPEC, publisher: "vw.com.br", document: "Manual Gol 2021", sourceClass: "manufacturer_manual" },
      },
    ]);
    expect(await manualReadings(tx).listManualReadings(GOL_16)).toEqual([]);
  }));
});
