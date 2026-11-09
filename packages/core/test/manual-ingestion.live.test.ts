/**
 * Test design (testing-strategy) — the manual-ingestion job, on a scratch database
 *
 * SUT: `ingestNextManual` (slice `quotes/ingest-manuals`) over the real store and the real
 *   `unpdf` extractor, with a fake HTTP client serving the authored fixture PDF. A scratch
 *   database of its own (created, migrated, dropped per run) because the job scans EVERY
 *   recorded candidate: on the shared database, real candidates (the 2026-09-25 run's, or a
 *   dev worker's) would decide which URL a tick claims. Each case also rolls back.
 *
 * Oracle: ingest-harvested-manuals D1–D3 and oil-manual-ingestion:
 *   - "Only a manufacturer manual that names the vehicle is ingested" (a T-Cross manual is
 *     never queued for a Gol);
 *   - "Two identities share one manual: one download, two readings";
 *   - "A definite answer ends a candidate; a transient failure leaves it pending" (404 refused
 *     and not retried; 503 retried with backoff, a definite `failed` after three);
 *   - the kill switch `MANUAL_INGESTION_ENABLED=false` does nothing;
 *   - a claim abandoned mid-read is taken again after its lease;
 *   - `oil_source_candidate` is only read.
 *   Second review of #180: the attempt and the `parsing` state are committed BEFORE the parse,
 *   so a parse that kills the worker still counts, and a URL that died parsing three times is a
 *   definite `failed` rather than parsed again; NUL is stripped from page text.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { shouldRunLiveTests } from "@select-lub/core/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type DbClient } from "../src/kernel/db.js";
import { ingestNextManual } from "../src/modules/quotes/ingest-manuals/index.js";
import type { ManualHttp } from "../src/modules/quotes/internal/manuals/document-fetcher.js";
import type { ManualTextExtractor } from "../src/modules/quotes/internal/manuals/text-extractor.js";
import { runInTransactionOnTx, withConnectRetry, withTestTransaction } from "../src/testing/index.js";
import { createScratchDatabase, type ScratchDatabase } from "./scratch-database.js";

const hasDatabase = shouldRunLiveTests();
const repoRoot = resolve(import.meta.dirname, "../../..");
const SCRATCH_SETUP_TIMEOUT_MS = 180_000;
const MANUAL_PDF = new Uint8Array(readFileSync(resolve(import.meta.dirname, "../src/modules/quotes/internal/manuals/fixtures/manual-5-pages.pdf")));

const VW = "https://www.vw.com.br/manuais";
const GOL_2021 = `${VW}/gol-2021.pdf`;
const TCROSS_2021 = `${VW}/t-cross-2021.pdf`;
const GOL_2020 = `${VW}/gol-2020.pdf`;
const NOW = new Date("2026-09-26T12:00:00.000Z");

/** Serves the fixture PDF, or a status per URL, as the guarded client would; counts document GETs. */
function http(statusFor: Record<string, number> = {}) {
  const gets: string[] = [];
  const client: ManualHttp = vi.fn(async (url, init) => {
    const robots = url.endsWith("/robots.txt");
    const status = robots ? 404 : (statusFor[url] ?? 200);
    if (!robots && init.method === "GET") gets.push(url);
    const headers: Record<string, string> = { "content-type": "application/pdf", "content-length": String(MANUAL_PDF.byteLength) };
    // A fresh copy per response: the extractor takes the bytes it is handed.
    const body = robots || init.method === "HEAD" || status >= 300 ? new Uint8Array() : MANUAL_PDF.slice();
    return { status, url, headers: { get: (name: string) => (robots ? null : (headers[name] ?? null)) }, body, truncated: false, text: async () => "" };
  });
  return { client, gets };
}

async function candidate(tx: DbClient, url: string, label: string, version = "1.0 FLEX 12V 4P") {
  await tx.oilSourceCandidate.create({
    data: {
      make: "Volkswagen", year: 2021, model: "Gol", version, url, publisher: "vw.com.br",
      classification: "manufacturer_manual", tier: 1, label, foundAt: NOW,
    },
  });
}

describe.skipIf(!hasDatabase)("quotes/ingest-manuals — live, on a scratch database", () => {
  let scratch: ScratchDatabase | undefined;
  let prisma!: PrismaClient;

  beforeAll(async () => {
    scratch = await createScratchDatabase(process.env.DATABASE_URL ?? "", "manual_ingestion", repoRoot);
    prisma = withConnectRetry(new PrismaClient({ datasourceUrl: scratch.url }));
  }, SCRATCH_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await prisma?.$disconnect();
    } finally {
      await scratch?.drop();
    }
  }, SCRATCH_SETUP_TIMEOUT_MS);

  afterEach(() => {
    delete process.env.MANUAL_INGESTION_ENABLED;
  });

  const inTx = (fn: (tx: DbClient) => Promise<void>) => () => withTestTransaction(prisma, fn);
  const tick = (tx: DbClient, client: ManualHttp, at: Date = NOW, extract?: ManualTextExtractor) =>
    ingestNextManual({ db: createDb(tx, runInTransactionOnTx(tx)), http: client, now: () => at, log: () => {}, ...(extract ? { extract } : {}) });

  it("queues only the manual naming the car, reads it, and stores its pages", inTx(async (tx) => {
    await candidate(tx, TCROSS_2021, "Manual T-Cross 2021");
    await candidate(tx, GOL_2021, "Manual Gol 2021");
    const before = await tx.oilSourceCandidate.count();

    const result = await tick(tx, http().client);

    expect(result).toMatchObject({ queued: 1, url: GOL_2021, outcome: "read" });
    expect(await tx.oilManualIngestion.findMany({ select: { url: true, state: true } })).toEqual([{ url: GOL_2021, state: "ingested" }]);
    const docs = await tx.oilManualDocument.findMany({ select: { url: true, pages: true, sha256: true } });
    expect(docs).toEqual([{ url: GOL_2021, pages: 5, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    const page3 = await tx.oilManualPage.findFirstOrThrow({ where: { pageNumber: 3 } });
    expect(page3.text).toContain("Capacidade com filtro: 4,0 litros");
    expect(await tx.oilManualReading.findMany({ select: { url: true, version: true, status: true } })).toEqual([
      { url: GOL_2021, version: "1.0 FLEX 12V 4P", status: "pending" },
    ]);
    expect(await tx.oilSourceCandidate.count()).toBe(before);
  }));

  it("two identities share one manual: one download, two readings", inTx(async (tx) => {
    await candidate(tx, GOL_2021, "Manual Gol 2021", "1.0 FLEX 12V 4P");
    await candidate(tx, GOL_2021, "Manual Gol 2021", "1.6 MSI");
    const { client, gets } = http();

    await tick(tx, client);
    const second = await tick(tx, client);

    expect(second.outcome).toBe("idle");
    expect(gets.filter((u) => u === GOL_2021)).toHaveLength(1);
    expect(await tx.oilManualIngestion.count()).toBe(1);
    expect(await tx.oilManualDocument.count()).toBe(1);
    expect((await tx.oilManualReading.findMany({ select: { version: true }, orderBy: { version: "asc" } })).map((r) => r.version)).toEqual([
      "1.0 FLEX 12V 4P",
      "1.6 MSI",
    ]);
  }));

  it("refuses a 404 for good, and the car queues its next-best manual", inTx(async (tx) => {
    await candidate(tx, GOL_2021, "Manual Gol 2021");
    await candidate(tx, GOL_2020, "Manual Gol 2020");
    process.env.MANUALS_PER_IDENTITY = "1";
    try {
      const { client, gets } = http({ [GOL_2021]: 404 });

      const first = await tick(tx, client);
      const second = await tick(tx, client);

      expect(first).toMatchObject({ url: GOL_2021, outcome: "refused" });
      expect(await tx.oilManualIngestion.findUniqueOrThrow({ where: { url: GOL_2021 } })).toMatchObject({ state: "refused", definite: true, reason: "status: 404" });
      // The 2021 manual is not tried again; the 2020 one takes its place.
      expect(second).toMatchObject({ url: GOL_2020, outcome: "read" });
      expect(gets.filter((u) => u === GOL_2021)).toHaveLength(0);
    } finally {
      delete process.env.MANUALS_PER_IDENTITY;
    }
  }));

  it("lets a failed URL free its place for the car's next-best manual", inTx(async (tx) => {
    await candidate(tx, GOL_2021, "Manual Gol 2021");
    await candidate(tx, GOL_2020, "Manual Gol 2020");
    await tx.oilManualIngestion.create({ data: { url: GOL_2021, state: "failed", definite: true, attempts: 3 } });
    await tx.oilManualReading.create({ data: { url: GOL_2021, make: "Volkswagen", year: 2021, model: "Gol", version: "1.0 FLEX 12V 4P" } });
    process.env.MANUALS_PER_IDENTITY = "1";
    try {
      expect(await tick(tx, http().client)).toMatchObject({ queued: 1, url: GOL_2020, outcome: "read" });
    } finally {
      delete process.env.MANUALS_PER_IDENTITY;
    }
  }));

  it("retries a 503 after its backoff, and fails it for good after three", inTx(async (tx) => {
    await candidate(tx, GOL_2021, "Manual Gol 2021");
    const { client } = http({ [GOL_2021]: 503 });

    expect(await tick(tx, client)).toMatchObject({ outcome: "failed" });
    const pending = await tx.oilManualIngestion.findUniqueOrThrow({ where: { url: GOL_2021 } });
    expect(pending).toMatchObject({ state: "pending", attempts: 1, definite: false });
    expect(pending.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 15 * 60_000);
    // Not due yet at the same instant.
    expect(await tick(tx, client)).toMatchObject({ outcome: "idle" });

    const later = (min: number) => new Date(NOW.getTime() + min * 60_000);
    expect(await tick(tx, client, later(16))).toMatchObject({ outcome: "failed" });
    expect(await tick(tx, client, later(60))).toMatchObject({ outcome: "failed" });
    expect(await tx.oilManualIngestion.findUniqueOrThrow({ where: { url: GOL_2021 } })).toMatchObject({
      state: "failed",
      definite: true,
      attempts: 3,
    });
    expect(await tick(tx, client, later(600))).toMatchObject({ outcome: "idle" });
  }));

  it("takes a claim abandoned mid-read again after its lease", inTx(async (tx) => {
    await candidate(tx, GOL_2021, "Manual Gol 2021");
    await tx.oilManualIngestion.create({ data: { url: GOL_2021, state: "ingesting", nextAttemptAt: new Date(NOW.getTime() - 1) } });

    expect(await tick(tx, http().client)).toMatchObject({ url: GOL_2021, outcome: "read" });
  }));

  it("commits the attempt and the parsing state before the parse starts", inTx(async (tx) => {
    await candidate(tx, GOL_2021, "Manual Gol 2021");
    let seen: unknown;
    // The parse looks at the row: whatever it finds is what a crash here would leave behind.
    const looking: ManualTextExtractor = async () => {
      seen = await tx.oilManualIngestion.findUniqueOrThrow({ where: { url: GOL_2021 }, select: { state: true, attempts: true } });
      return { ok: true, pages: ["Óleo 5W-40"] };
    };

    expect(await tick(tx, http().client, NOW, looking)).toMatchObject({ outcome: "read" });
    expect(seen).toEqual({ state: "parsing", attempts: 1 });
  }));

  it("fails for good a URL whose parse died three times, instead of parsing it again", inTx(async (tx) => {
    await candidate(tx, GOL_2021, "Manual Gol 2021");
    // What three crashed parses leave: `parsing`, attempts counted, the lease run out.
    await tx.oilManualIngestion.create({ data: { url: GOL_2021, state: "parsing", attempts: 3, nextAttemptAt: new Date(NOW.getTime() - 1) } });
    const { client, gets } = http();

    expect(await tick(tx, client)).toMatchObject({ url: null, outcome: "idle" });
    expect(await tx.oilManualIngestion.findUniqueOrThrow({ where: { url: GOL_2021 } })).toMatchObject({
      state: "failed",
      definite: true,
      reason: expect.stringContaining("the parse never finished in 3 attempts"),
    });
    expect(gets).toEqual([]);
  }));

  it("takes a URL whose parse died once again, counting the attempt", inTx(async (tx) => {
    await candidate(tx, GOL_2021, "Manual Gol 2021");
    await tx.oilManualIngestion.create({ data: { url: GOL_2021, state: "parsing", attempts: 1, nextAttemptAt: new Date(NOW.getTime() - 1) } });

    expect(await tick(tx, http().client)).toMatchObject({ url: GOL_2021, outcome: "read" });
    expect(await tx.oilManualIngestion.findUniqueOrThrow({ where: { url: GOL_2021 } })).toMatchObject({ state: "ingested", attempts: 2 });
  }));

  it("strips NUL from page text, which Postgres TEXT refuses", inTx(async (tx) => {
    await candidate(tx, GOL_2021, "Manual Gol 2021");
    const nul: ManualTextExtractor = async () => ({ ok: true, pages: ["Óleo\u0000 5W-40", "Capacidade 4,0 L\u0000"] });

    expect(await tick(tx, http().client, NOW, nul)).toMatchObject({ outcome: "read" });
    expect((await tx.oilManualPage.findMany({ orderBy: { pageNumber: "asc" }, select: { text: true } })).map((p) => p.text)).toEqual([
      "Óleo 5W-40",
      "Capacidade 4,0 L",
    ]);
  }));

  it("does nothing when switched off", inTx(async (tx) => {
    await candidate(tx, GOL_2021, "Manual Gol 2021");
    process.env.MANUAL_INGESTION_ENABLED = "false";
    const { client, gets } = http();

    expect(await tick(tx, client)).toEqual({ queued: 0, url: null, outcome: "off" });
    expect(await tx.oilManualIngestion.count()).toBe(0);
    expect(gets).toEqual([]);
  }));
});
