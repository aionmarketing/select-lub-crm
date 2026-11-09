/**
 * Test design (testing-strategy) — a lost lease writes nothing, on a scratch database
 *
 * SUT: the ingestion store's writes (`markParsing`, `recordManualRead`, `recordManualFailure`)
 *   and the `quotes/ingest-manuals` tick, on the real store. A scratch database of its own,
 *   like manual-ingestion.live.test.ts, because a tick scans every recorded candidate; each case
 *   also rolls back.
 *
 * Oracle: review of #181 (2026-09-26, MEDIUM; the repo's rule for state transitions): every write
 *   after a claim is a compare-and-set on that claim — the URL, the state the claim left, and the
 *   attempts it counted. A worker whose lease ran out and whose URL was claimed again changes
 *   nothing: no state, no attempts, and no second document or page set; it reports the lease
 *   lost, and the tick says `lost`. The state matters as much as the attempts: the sweep marks
 *   an exhausted claim `failed` without changing its attempts, and that claim must not write.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { shouldRunLiveTests } from "@select-lub/core/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type DbClient } from "../src/kernel/db.js";
import { ingestNextManual } from "../src/modules/quotes/ingest-manuals/index.js";
import type { ManualHttp } from "../src/modules/quotes/internal/manuals/document-fetcher.js";
import {
  claimNextManual,
  markParsing,
  recordManualFailure,
  recordManualRead,
} from "../src/modules/quotes/internal/manuals/ingestion-store.js";
import type { ManualTextExtractor } from "../src/modules/quotes/internal/manuals/text-extractor.js";
import { runInTransactionOnTx, withConnectRetry, withTestTransaction } from "../src/testing/index.js";
import { createScratchDatabase, type ScratchDatabase } from "./scratch-database.js";

const hasDatabase = shouldRunLiveTests();
const repoRoot = resolve(import.meta.dirname, "../../..");
const SCRATCH_SETUP_TIMEOUT_MS = 180_000;
const MANUAL_PDF = new Uint8Array(readFileSync(resolve(import.meta.dirname, "../src/modules/quotes/internal/manuals/fixtures/manual-5-pages.pdf")));
const GOL_2021 = "https://www.vw.com.br/manuais/gol-2021.pdf";
const NOW = new Date("2026-09-26T12:00:00.000Z");
const LEASE_MS = 60_000;
const READ = { sha256: "a".repeat(64), bytes: 1000, pages: ["Óleo 5W-40"], fetchMs: 10, parseMs: 10 };

/**
 * Serves the fixture PDF as the guarded client would; `onGet` runs when the document is fetched,
 * and `status` answers the document's GET.
 */
function http(onGet: () => Promise<void> = async () => undefined, status = 200): ManualHttp {
  return vi.fn(async (url, init) => {
    const robots = url.endsWith("/robots.txt");
    const get = !robots && init.method === "GET";
    if (get) await onGet();
    const headers: Record<string, string> = { "content-type": "application/pdf", "content-length": String(MANUAL_PDF.byteLength) };
    const body = robots || init.method === "HEAD" || (get && status !== 200) ? new Uint8Array() : MANUAL_PDF.slice();
    const answer = robots ? 404 : get ? status : 200;
    return { status: answer, url, headers: { get: (name: string) => (robots ? null : (headers[name] ?? null)) }, body, truncated: false, text: async () => "" };
  });
}

/** What another worker's claim does to the row: the attempt counted again, the row `ingesting`. */
const reclaimedByAnother = (tx: DbClient) =>
  tx.oilManualIngestion.update({ where: { url: GOL_2021 }, data: { state: "ingesting", attempts: { increment: 1 }, nextAttemptAt: new Date(NOW.getTime() + LEASE_MS) } });

describe.skipIf(!hasDatabase)("quotes/ingest-manuals — a lost lease writes nothing (live, scratch database)", () => {
  let scratch: ScratchDatabase | undefined;
  let prisma!: PrismaClient;

  beforeAll(async () => {
    scratch = await createScratchDatabase(process.env.DATABASE_URL ?? "", "manual_ingestion_lease", repoRoot);
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
  const row = (tx: DbClient) => tx.oilManualIngestion.findUniqueOrThrow({ where: { url: GOL_2021 }, select: { state: true, attempts: true, reason: true } });

  it("a stale worker's writes after a re-claim change nothing, and store no document", inTx(async (tx) => {
    await tx.oilManualIngestion.create({ data: { url: GOL_2021 } });
    const stale = await claimNextManual(tx, NOW, LEASE_MS);
    // The stale worker's lease runs out; another worker claims the URL and starts parsing it.
    const fresh = await claimNextManual(tx, new Date(NOW.getTime() + LEASE_MS + 1), LEASE_MS);
    expect(stale).toEqual({ url: GOL_2021, attempts: 1 });
    expect(fresh).toEqual({ url: GOL_2021, attempts: 2 });
    expect(await markParsing(tx, fresh!, NOW, LEASE_MS)).toBe(true);
    const before = await row(tx);

    expect(await markParsing(tx, stale!, NOW, LEASE_MS)).toBe(false);
    expect(await recordManualRead(tx, stale!, READ, NOW)).toBeNull();
    expect(await recordManualFailure(tx, stale!, { definite: true, reason: "status: 404" }, NOW)).toBe(false);
    expect(await recordManualFailure(tx, stale!, { definite: false, reason: "status: 503" }, NOW)).toBe(false);

    expect(await row(tx)).toEqual(before);
    expect(await tx.oilManualDocument.count()).toBe(0);
    expect(await tx.oilManualPage.count()).toBe(0);
    // The claim that holds the row still records its read, once.
    expect(await recordManualRead(tx, fresh!, READ, NOW)).toEqual(expect.any(String));
    expect(await tx.oilManualDocument.count()).toBe(1);
    expect(await row(tx)).toMatchObject({ state: "ingested", attempts: 2 });
  }));

  it("a claim the sweep marked failed writes nothing: the state is part of the claim, not only the attempts", inTx(async (tx) => {
    // The last attempt: the claim counts the third, and the worker then goes quiet past its lease.
    await tx.oilManualIngestion.create({ data: { url: GOL_2021, attempts: 2 } });
    const last = await claimNextManual(tx, NOW, LEASE_MS);
    expect(last).toEqual({ url: GOL_2021, attempts: 3 });
    // The next claim sweeps it to a definite `failed`, leaving attempts at 3, the same as the claim's.
    expect(await claimNextManual(tx, new Date(NOW.getTime() + LEASE_MS + 1), LEASE_MS)).toBeNull();
    const swept = await row(tx);
    expect(swept).toMatchObject({ state: "failed", attempts: 3 });

    expect(await markParsing(tx, last!, NOW, LEASE_MS)).toBe(false);
    expect(await recordManualFailure(tx, last!, { definite: false, reason: "status: 503" }, NOW)).toBe(false);
    expect(await recordManualRead(tx, last!, READ, NOW)).toBeNull();

    expect(await row(tx)).toEqual(swept);
    expect(await tx.oilManualDocument.count()).toBe(0);
  }));

  it("a parsing claim swept to failed stores no read", inTx(async (tx) => {
    await tx.oilManualIngestion.create({ data: { url: GOL_2021, attempts: 2 } });
    const last = await claimNextManual(tx, NOW, LEASE_MS);
    expect(await markParsing(tx, last!, NOW, LEASE_MS)).toBe(true);
    expect(await claimNextManual(tx, new Date(NOW.getTime() + LEASE_MS + 1), LEASE_MS)).toBeNull();
    const swept = await row(tx);
    expect(swept).toMatchObject({ state: "failed", attempts: 3 });

    expect(await recordManualRead(tx, last!, READ, NOW)).toBeNull();

    expect(await row(tx)).toEqual(swept);
    expect(await tx.oilManualDocument.count()).toBe(0);
  }));

  it("stores nothing when the URL is claimed again while it is being parsed", inTx(async (tx) => {
    await tx.oilSourceCandidate.create({
      data: { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0", url: GOL_2021, publisher: "vw.com.br", classification: "manufacturer_manual", tier: 1, label: "Manual Gol 2021", foundAt: NOW },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const slowParse: ManualTextExtractor = async () => {
      await reclaimedByAnother(tx);
      return { ok: true, pages: ["Óleo 5W-40"] };
    };
    try {
      const result = await ingestNextManual({ db: createDb(tx, runInTransactionOnTx(tx)), http: http(), extract: slowParse, now: () => NOW, log: () => {} });

      expect(result).toMatchObject({ url: GOL_2021, outcome: "lost" });
      expect(await tx.oilManualDocument.count()).toBe(0);
      expect(await row(tx)).toMatchObject({ state: "ingesting", attempts: 2 });
      expect(warn).toHaveBeenCalledWith("manual-ingest", expect.stringContaining('"outcome":"lost_lease"'));
    } finally {
      warn.mockRestore();
    }
  }));

  it("does not parse when the URL is claimed again while it is being downloaded", inTx(async (tx) => {
    await tx.oilSourceCandidate.create({
      data: { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0", url: GOL_2021, publisher: "vw.com.br", classification: "manufacturer_manual", tier: 1, label: "Manual Gol 2021", foundAt: NOW },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const extract = vi.fn<ManualTextExtractor>(async () => ({ ok: true, pages: ["x"] }));
    try {
      const result = await ingestNextManual({
        db: createDb(tx, runInTransactionOnTx(tx)),
        http: http(() => reclaimedByAnother(tx).then(() => undefined)),
        extract,
        now: () => NOW,
        log: () => {},
      });

      expect(result).toMatchObject({ url: GOL_2021, outcome: "lost" });
      expect(extract).not.toHaveBeenCalled();
      expect(await row(tx)).toMatchObject({ state: "ingesting", attempts: 2 });
    } finally {
      warn.mockRestore();
    }
  }));

  it("records no failure when the URL was claimed again while its download failed", inTx(async (tx) => {
    await tx.oilSourceCandidate.create({
      data: { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0", url: GOL_2021, publisher: "vw.com.br", classification: "manufacturer_manual", tier: 1, label: "Manual Gol 2021", foundAt: NOW },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await ingestNextManual({
        db: createDb(tx, runInTransactionOnTx(tx)),
        http: http(() => reclaimedByAnother(tx).then(() => undefined), 404),
        now: () => NOW,
        log: () => {},
      });

      // The 404 was this worker's to record, but the URL is another's now: it stays theirs.
      expect(result).toMatchObject({ url: GOL_2021, outcome: "lost" });
      expect(await row(tx)).toMatchObject({ state: "ingesting", attempts: 2, reason: null });
    } finally {
      warn.mockRestore();
    }
  }));
});
