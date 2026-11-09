/**
 * Test design (testing-strategy) — a run that ends without a resting outcome still queues its manual
 *
 * SUT: `quotes/run-oil-research`'s tick over the fake ports, on a scratch database; the sweep's
 *   manual-upgrade check for the `failed` identity it leaves. Module role: `quotes`.
 *
 * Why a scratch database: the claims take any due row.
 *
 * Oracle: oil-research-web-retrieval D4, D5; specs `quotes/oil-research` "A run that ends without
 *   a resting outcome still queues the manual it found" and `quotes/oil-source-candidates` "Every
 *   manual candidate is persisted" (a candidate is kept whatever the run ends with).
 *
 * Axes
 *   T1 how the run ends — an outage to retry / the last attempt (`failed`)
 *   T2 manual ingestion — on / off
 *   T3 what the retrieval found beside the outage — a manual naming the model / nothing
 *
 * Sampled cells (one row per `it`)
 *   outage + manual            | T1,T3 | candidate row written, ONE reading queued, the row `queued` for retry and
 *      NOT `waiting_manual` (waiting is for a completed search)
 *   three attempts + manual    | T1,T3 | `failed`, still ONE reading and ONE ingestion row though the candidate
 *      was found three times
 *   ingestion off              | T2    | nothing queued, the candidate still written
 *   outage, no candidate       | T3    | nothing queued
 *   a verified reading later   | T1    | the sweep enqueues a `manual_resolve` for the failed identity and it
 *      resolves `verified` from the manual with no web search
 *
 * Out of scope: the wait for a complete no-source search (oil-research-manuals.live.test.ts).
 */
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { shouldRunLiveTests, type DbClient } from "@select-lub/core/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityKey } from "../src/modules/quotes/internal/research/identity-key.js";
import { enqueueResearch, type EnqueueRequest } from "../src/modules/quotes/internal/research/research-store.js";
import { createOutageBreaker, runOilResearchTick } from "../src/modules/quotes/run-oil-research/index.js";
import { sweepOilResearch } from "../src/modules/quotes/sweep-oil-research/index.js";
import { withConnectRetry, withTestTransaction } from "../src/testing/index.js";
import { at, fakePorts, MIN, NOW, readingSpec, SETTINGS, trackedDb, type FakeScript } from "./oil-research-harness.js";
import { createScratchDatabase, type ScratchDatabase } from "./scratch-database.js";

const hasDatabase = shouldRunLiveTests();
const repoRoot = resolve(import.meta.dirname, "../../..");
const SCRATCH_SETUP_TIMEOUT_MS = 180_000;

const HB20 = { make: "Hyundai", year: 2022, model: "HB20", version: "1.0 12V Flex" };
const MANUAL = "https://www.hyundai.com.br/dam/hb20-2022.pdf";

const research = (tx: DbClient) => tx.oilResearch.findUniqueOrThrow({ where: { identityKey: identityKey(HB20)! } });

/** Motul down, the web found only the manufacturer's manual: the HB20 of 2026-10-04. */
const motulDownButAManual: FakeScript["retrieve"] = async () => ({
  status: "unavailable",
  manualCandidates: [{ url: MANUAL, publisher: "hyundai.com.br", classification: "manufacturer_manual", tier: 1, label: "Manual HB20 2022" }],
});

describe.skipIf(!hasDatabase)("a run that ends without a resting outcome — live, on a scratch database", () => {
  let scratch: ScratchDatabase | undefined;
  let prisma!: PrismaClient;

  beforeAll(async () => {
    scratch = await createScratchDatabase(process.env.DATABASE_URL ?? "", "oil_research_transient", repoRoot);
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

  function runner(tx: DbClient, script: FakeScript, settings = SETTINGS) {
    const db = trackedDb(tx);
    const { ports, probe } = fakePorts(db, { storedReadingsOn: tx, ...script });
    const breaker = createOutageBreaker(settings.outageBreaker);
    const tick = (now = NOW) => runOilResearchTick({ db, ports, settings, now: () => now, breaker }, new AbortController().signal);
    const enqueue = (request: EnqueueRequest, now = NOW) => db.tx("quotes", (q) => enqueueResearch(q, request, now));
    const sweep = (now: Date) => sweepOilResearch({ db, settings, keySet: () => true, searchAvailable: () => true, now: () => now });
    return { db, probe, tick, enqueue, sweep };
  }

  const request: EnqueueRequest = { identity: HB20, kind: "full", priority: 0, trigger: "quote_open" };

  it("writes the candidate and queues the manual on an outage, without waiting for it", inTx(async (tx) => {
    const r = runner(tx, { retrieve: motulDownButAManual });
    await r.enqueue(request);

    expect(await r.tick()).toMatchObject({ run: { outcome: "unavailable", state: "queued" } });

    expect(await tx.oilSourceCandidate.count({ where: { url: MANUAL } })).toBe(1);
    expect(await tx.oilManualReading.count({ where: { url: MANUAL, model: "HB20" } })).toBe(1);
    expect(await tx.oilManualIngestion.count({ where: { url: MANUAL } })).toBe(1);
    expect(await research(tx)).toMatchObject({ state: "queued", attempts: 1 });
  }));

  it("ends failed after three attempts with the manual queued once, though found three times", inTx(async (tx) => {
    const r = runner(tx, { retrieve: motulDownButAManual });
    await r.enqueue(request);

    await r.tick();
    await r.tick(at(5 * MIN));
    expect(await r.tick(at(20 * MIN))).toMatchObject({ run: { outcome: "failed", state: "failed" } });

    expect(await tx.oilSourceCandidate.count({ where: { url: MANUAL } })).toBe(3);
    expect(await tx.oilManualReading.count({ where: { url: MANUAL, model: "HB20" } })).toBe(1);
    expect(await tx.oilManualIngestion.count({ where: { url: MANUAL } })).toBe(1);
  }));

  it("queues nothing with manual ingestion switched off, but keeps the candidate", inTx(async (tx) => {
    const r = runner(tx, { retrieve: motulDownButAManual }, { ...SETTINGS, manualIngestion: false });
    await r.enqueue(request);

    await r.tick();

    expect(await tx.oilSourceCandidate.count({ where: { url: MANUAL } })).toBe(1);
    expect(await tx.oilManualReading.count()).toBe(0);
    expect(await tx.oilManualIngestion.count()).toBe(0);
  }));

  it("queues nothing when the outage found no manual", inTx(async (tx) => {
    const r = runner(tx, { retrieve: async () => ({ status: "unavailable" }) });
    await r.enqueue(request);

    expect(await r.tick()).toMatchObject({ run: { outcome: "unavailable" } });

    expect(await tx.oilSourceCandidate.count()).toBe(0);
    expect(await tx.oilManualReading.count()).toBe(0);
  }));

  it("resolves a failed car from the manual once it is read, with no web search", inTx(async (tx) => {
    const r = runner(tx, { retrieve: motulDownButAManual });
    await r.enqueue(request);
    await r.tick();
    await r.tick(at(5 * MIN));
    await r.tick(at(20 * MIN));
    expect(await research(tx)).toMatchObject({ state: "failed" });

    // The manual is downloaded and read after the last attempt began.
    await tx.oilManualIngestion.update({ where: { url: MANUAL }, data: { state: "ingested" } });
    await tx.oilManualReading.updateMany({
      where: { url: MANUAL, model: "HB20" },
      data: {
        status: "verified",
        readAt: at(30 * MIN),
        citedPage: "p. 212",
        excerpt: "Óleo do motor SAE 5W-30. Quantidade de óleo com filtro: 3,8 litros",
        spec: readingSpec(["5W-30"], 3.8),
      },
    });

    expect((await r.sweep(at(31 * MIN))).upgraded).toEqual([identityKey(HB20)]);
    expect(await r.tick(at(31 * MIN))).toMatchObject({ run: { outcome: "verified" } });

    expect(await research(tx)).toMatchObject({ state: "verified", kind: "manual_resolve" });
    expect(r.probe.contexts.at(-1)?.skipWebSearch).toBe(true);
    expect(await tx.motulCompatibility.findFirstOrThrow({ where: { model: "HB20" } })).toMatchObject({ sourceUrl: MANUAL, sourcePage: "p. 212", sourceAuthority: 1 });
  }));
});
