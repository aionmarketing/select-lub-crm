/**
 * Test design (testing-strategy) — the manual path of background research, on a scratch database
 *
 * SUT: `quotes/run-oil-research`'s tick through a stage-1 miss, the manual wait and the
 *   re-resolve (D11); the manual queues' claim order (D11); and `quotes/read-manuals`' budget, run
 *   row and release on stop (D13, D19). The runner runs over the fake ports; the re-resolve reads
 *   the REAL stored readings of the test transaction (the stored-manual retriever) and, when the
 *   current answer came from a web page, that page's stored passage. Module role: `quotes`.
 *
 * Why a scratch database: the claims (research, ingestion, reading) take any due row.
 *
 * Oracle: background-oil-research D11, D13, D19 and tasks 3.5, 3.6 (the reading's release) and
 *   3.7's Verify lists; `oil-research` "A manual found by the search is waited for, within a bound";
 *   ingest-harvested-manuals D5 (a manual's dry volume is recorded with its type, never priced).
 */
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { shouldRunLiveTests, type DbClient } from "@select-lub/core/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimNextManual } from "../src/modules/quotes/internal/manuals/ingestion-store.js";
import { claimNextReading } from "../src/modules/quotes/internal/manuals/reading-store.js";
import { compatibilityCaches } from "../src/modules/quotes/internal/store/compatibility-caches.js";
import { shownRowResult } from "../src/modules/quotes/internal/quote-answer/shown-row.js";
import { daySpendUsd } from "../src/modules/quotes/internal/research/budget.js";
import { identityKey } from "../src/modules/quotes/internal/research/identity-key.js";
import { enqueueResearch, type EnqueueRequest } from "../src/modules/quotes/internal/research/research-store.js";
import { createOutageBreaker, runOilResearchTick } from "../src/modules/quotes/run-oil-research/index.js";
import { readNextManual } from "../src/modules/quotes/read-manuals/index.js";
import { sweepOilResearch } from "../src/modules/quotes/sweep-oil-research/index.js";
import { withConnectRetry, withTestTransaction } from "../src/testing/index.js";
import { at, fakePorts, modelCall, manualCandidate, MIN, NOW, readingSpec, SETTINGS, trackedDb, type FakeScript } from "./oil-research-harness.js";
import { createScratchDatabase, type ScratchDatabase } from "./scratch-database.js";

const hasDatabase = shouldRunLiveTests();
const repoRoot = resolve(import.meta.dirname, "../../..");
const SCRATCH_SETUP_TIMEOUT_MS = 180_000;

const GOL = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0 FLEX 12V 4P" };
const ARGO = { make: "Fiat", year: 2022, model: "Argo", version: "1.3 Drive" };
type Identity = typeof GOL;
const MANUAL = "https://www.vw.com.br/manuais/gol-2021.pdf";
const ARGO_MANUAL = "https://www.fiat.com.br/manuais/argo-2022.pdf";

const research = (tx: DbClient, identity: Identity) => tx.oilResearch.findUniqueOrThrow({ where: { identityKey: identityKey(identity)! } });

/** Stage 1: the search found nothing readable, only the manufacturer's manual. */
const noSourceButAManual = (identity: Identity, url: string): FakeScript["retrieve"] => async () => ({
  status: "none",
  manualCandidates: [{ url, publisher: "vw.com.br", classification: "manufacturer_manual", tier: 1, label: `Manual ${identity.model} ${identity.year}` }],
});

describe.skipIf(!hasDatabase)("background research's manual path — live, on a scratch database", () => {
  let scratch: ScratchDatabase | undefined;
  let prisma!: PrismaClient;

  beforeAll(async () => {
    scratch = await createScratchDatabase(process.env.DATABASE_URL ?? "", "oil_research_manuals", repoRoot);
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
    return { db, probe, tick, enqueue };
  }

  /** The manual is downloaded; its reading for the identity ends as `status`. */
  async function readTheManual(tx: DbClient, identity: Identity, url: string, status: "verified" | "stated_nothing", readAt = at(5 * MIN), liters = 4) {
    await tx.oilManualIngestion.update({ where: { url }, data: { state: "ingested" } });
    await tx.oilManualReading.updateMany({
      where: { url, model: identity.model },
      data:
        status === "verified"
          ? { status, readAt, citedPage: "p. 238", excerpt: `Óleo do motor SAE 5W-40. Quantidade de óleo com filtro: ${String(liters).replace(".", ",")} litros`, spec: readingSpec(["5W-40"], liters) }
          : { status, readAt, citedPage: null, excerpt: null },
    });
  }

  describe("the wait (D11)", () => {
    it("waits for the manual a no-source search found, then verifies from it, cited to its page", inTx(async (tx) => {
      const r = runner(tx, { retrieve: noSourceButAManual(GOL, MANUAL) });
      await r.enqueue({ identity: GOL, kind: "full", priority: 0, trigger: "quote_open" });

      expect(await r.tick()).toMatchObject({ run: { outcome: "waiting_manual", state: "waiting_manual" } });
      const waiting = await research(tx, GOL);
      expect(waiting).toMatchObject({ state: "waiting_manual", waitStartedAt: NOW, manualWaitUntil: at(30 * MIN), priority: 0 });
      expect(await tx.oilManualReading.count({ where: { url: MANUAL } })).toBe(1);

      // Still to come: the next tick leaves it waiting.
      expect(await r.tick(at(MIN))).toEqual({ outcome: "idle" });
      await readTheManual(tx, GOL, MANUAL, "verified");

      expect(await r.tick(at(6 * MIN))).toMatchObject({ run: { outcome: "verified" } });
      expect(await research(tx, GOL)).toMatchObject({ state: "verified", kind: "manual_resolve", trigger: "wait_ended", priority: 0, requestedAt: NOW });
      const cache = await tx.motulCompatibility.findFirstOrThrow({ where: { model: "Gol" } });
      expect(cache).toMatchObject({ sourcePage: "p. 238", sourceUrl: MANUAL, sourceAuthority: 1, viscosities: ["5W-40"] });
      // The re-resolve searched no web.
      expect(r.probe.contexts.at(-1)?.skipWebSearch).toBe(true);
    }));

    // ingest-harvested-manuals D5: a manual's dry figure is recorded with its type and never priced.
    it("records a manual's dry volume on the cache row, with no priced liters", inTx(async (tx) => {
      const r = runner(tx, { retrieve: noSourceButAManual(GOL, MANUAL) });
      await r.enqueue({ identity: GOL, kind: "full", priority: 0, trigger: "quote_open" });
      await r.tick();
      await tx.oilManualIngestion.update({ where: { url: MANUAL }, data: { state: "ingested" } });
      await tx.oilManualReading.updateMany({
        where: { url: MANUAL, model: GOL.model },
        data: {
          status: "verified",
          readAt: at(5 * MIN),
          citedPage: "p. 238",
          excerpt: "Óleo do motor SAE 5W-40. Volume seco do motor: 3,6 litros",
          spec: { ...readingSpec(["5W-40"], 3.6), fillKind: null, fillCondition: "dry" },
        },
      });

      expect(await r.tick(at(6 * MIN))).toMatchObject({ run: { outcome: "verified" } });
      const cache = await tx.motulCompatibility.findFirstOrThrow({ where: { model: "Gol" } });
      expect({ fillLiters: cache.fillLiters, fillKind: cache.fillKind, fillCondition: cache.fillCondition, unusableFillLiters: Number(cache.unusableFillLiters) }).toEqual({
        fillLiters: null,
        fillKind: null,
        fillCondition: "dry",
        unusableFillLiters: 3.6,
      });
    }));

    it("resolves as no source when the manual stated nothing", inTx(async (tx) => {
      const r = runner(tx, { retrieve: noSourceButAManual(GOL, MANUAL) });
      await r.enqueue({ identity: GOL, kind: "full", priority: 0, trigger: "quote_open" });
      await r.tick();
      await readTheManual(tx, GOL, MANUAL, "stated_nothing");

      await r.tick(at(6 * MIN));
      expect(await research(tx, GOL)).toMatchObject({ state: "no_spec", kind: "manual_resolve" });
    }));

    it("ends the wait at the next tick when the manual's download was refused", inTx(async (tx) => {
      const r = runner(tx, { retrieve: noSourceButAManual(GOL, MANUAL) });
      await r.enqueue({ identity: GOL, kind: "full", priority: 0, trigger: "quote_open" });
      await r.tick();
      await tx.oilManualIngestion.update({ where: { url: MANUAL }, data: { state: "refused", definite: true } });

      expect(await r.tick(at(MIN))).toMatchObject({ run: { outcome: "no_spec" } });
      expect(await research(tx, GOL)).toMatchObject({ state: "no_spec" });
    }));

    it("resolves with what is stored once the deadline passes", inTx(async (tx) => {
      const r = runner(tx, { retrieve: noSourceButAManual(GOL, MANUAL) });
      await r.enqueue({ identity: GOL, kind: "full", priority: 0, trigger: "quote_open" });
      await r.tick();

      expect(await r.tick(at(29 * MIN))).toEqual({ outcome: "idle" });
      expect(await r.tick(at(30 * MIN))).toMatchObject({ run: { outcome: "no_spec" } });
    }));

    it("does not wait with manual ingestion switched off", inTx(async (tx) => {
      const r = runner(tx, { retrieve: noSourceButAManual(GOL, MANUAL) }, { ...SETTINGS, manualIngestion: false });
      await r.enqueue({ identity: GOL, kind: "full", priority: 0, trigger: "quote_open" });

      expect(await r.tick()).toMatchObject({ run: { outcome: "no_spec" } });
    }));

    it("keeps a backfill cycle's re-resolve at priority 2", inTx(async (tx) => {
      const r = runner(tx, { retrieve: noSourceButAManual(GOL, MANUAL) });
      await tx.customer.create({ data: { origin: "CRM", status: "ACTIVE", vehicles: { create: { origin: "CRM", ...GOL } } } });
      await r.enqueue({ identity: GOL, kind: "full", priority: 2, trigger: "backfill" });
      await r.tick();
      await tx.oilManualIngestion.update({ where: { url: MANUAL }, data: { state: "failed", definite: true } });

      await r.tick(at(2 * MIN));
      expect(await research(tx, GOL)).toMatchObject({ kind: "manual_resolve", priority: 2 });
    }));

    it("surfaces a manual that disagrees with the web page behind the current answer", inTx(async (tx) => {
      const r = runner(tx, {});
      // Verified from a tier-3 page stating 4,3 L, its passage stored.
      const url = "https://oficina.example.com.br/gol";
      const excerpt = "Gol 2021 1.0: óleo SAE 5W-40, capacidade 4,3 L com filtro";
      const cited = { sourcePublisher: "oficina.example.com.br", sourceDocument: "Tabela", sourcePage: "Gol", sourceAuthority: 3, sourceUrl: url, sourceClassification: "licensed_database" as const, sourceExcerpt: excerpt };
      await compatibilityCaches(tx).insertCompatibility({
        ...GOL,
        viscosityGrades: ["5W-40"],
        viscosity: "5W-40",
        classification: "",
        fillLiters: 4.3,
        fillKind: "em_servico",
        consultedAt: at(-60 * MIN).toISOString(),
        rawPayload: null,
        ...cited,
        gradeSources: [{ grade: "5W-40", ...cited }],
        litersSource: cited,
      });
      await r.enqueue({ identity: GOL, kind: "full", priority: 0, trigger: "quote_open" });
      expect(await research(tx, GOL)).toMatchObject({ state: "verified", trigger: "adopted" });
      // A tier-1 manual reading of 4,0 L verifies afterwards; the upgrade re-resolves.
      await tx.oilManualIngestion.create({ data: { url: MANUAL, state: "ingested", attempts: 1 } });
      await tx.oilManualReading.create({ data: { url: MANUAL, ...GOL, status: "pending" } });
      await readTheManual(tx, GOL, MANUAL, "verified", at(-MIN), 4);
      await r.enqueue({ identity: GOL, kind: "manual_resolve", priority: 1, trigger: "manual_upgrade" });

      expect(await r.tick()).toMatchObject({ run: { outcome: "conflicting_sources" } });
      const row = await research(tx, GOL);
      const conflict = (row.outcomePayload as { conflicts: { field: string; values: { value: string; sourceAuthority: number }[] }[] }).conflicts;
      expect(conflict).toEqual([{ field: "fillLiters", values: [expect.objectContaining({ value: "4", sourceAuthority: 1 }), expect.objectContaining({ value: "4.3", sourceAuthority: 3 })] }]);
    }));

    // Review of #189: the re-resolve rebuilds the current web answer from its row, and must keep
    // the dry volume that row recorded, or a manual with grades and no liters would erase it.
    it("keeps the web page's dry volume through a re-resolve with a manual that states no liters", inTx(async (tx) => {
      const r = runner(tx, {});
      const url = "https://oficina.example.com.br/gol-seco";
      const excerpt = "Gol 2021 1.0: óleo SAE 5W-40, volume seco 3,6 L";
      const cited = { sourcePublisher: "oficina.example.com.br", sourceDocument: "Tabela", sourcePage: "Gol", sourceAuthority: 3, sourceUrl: url, sourceClassification: "licensed_database" as const, sourceExcerpt: excerpt };
      await compatibilityCaches(tx).insertCompatibility({
        ...GOL,
        viscosityGrades: ["5W-40"],
        viscosity: "5W-40",
        classification: "",
        fillLiters: null,
        fillKind: null,
        fillCondition: "dry",
        unusableFillLiters: 3.6,
        consultedAt: at(-60 * MIN).toISOString(),
        rawPayload: null,
        ...cited,
        gradeSources: [{ grade: "5W-40", ...cited }],
        litersSource: null,
      });
      await r.enqueue({ identity: GOL, kind: "full", priority: 0, trigger: "quote_open" });
      await tx.oilManualIngestion.create({ data: { url: MANUAL, state: "ingested", attempts: 1 } });
      await tx.oilManualReading.create({
        data: {
          url: MANUAL,
          ...GOL,
          status: "verified",
          readAt: at(-MIN),
          citedPage: "p. 238",
          excerpt: "Óleo do motor SAE 5W-40.",
          spec: { ...readingSpec(["5W-40"], 4), fillLiters: null, fillKind: null },
        },
      });
      await r.enqueue({ identity: GOL, kind: "manual_resolve", priority: 1, trigger: "manual_upgrade" });

      expect(await r.tick()).toMatchObject({ run: { outcome: "verified" } });
      const latest = await compatibilityCaches(tx).latestCompatibility(GOL);
      expect(latest).toMatchObject({ sourcePage: "p. 238", fillLiters: null, fillCondition: "dry", unusableFillLiters: 3.6 });
      // A stocked oil of the first grade, so the missing volume has a card to offer (background-oil-research D24).
      const grade = latest!.viscosityGrades[0]!;
      const stocked = { id: "oil", brand: "Motul", description: grade, price: 50, stock: 1, active: true, createdAt: "", updatedAt: "", lubricant: { catalogItemId: "oil", viscosity: grade, classification: "", oilType: null }, filter: null };
      const none = { status: "unavailable" } as const;
      expect(shownRowResult(latest!, [stocked], () => ({ source: "unavailable", consultedAt: null, application: null, oil: none, fuel: none }))).toMatchObject({
        status: "no_capacity",
        unusableFill: { liters: 3.6, condition: "dry" },
      });
    }));
  });

  describe("the manual queues' order (D11)", () => {
    it("downloads and reads a waiting quote's manual before a backfill identity's", inTx(async (tx) => {
      // The backfill identity's manual is older in the queue.
      const r = runner(tx, { retrieve: noSourceButAManual(ARGO, ARGO_MANUAL) });
      await tx.customer.create({ data: { origin: "CRM", status: "ACTIVE", vehicles: { create: { origin: "CRM", ...ARGO } } } });
      await r.enqueue({ identity: ARGO, kind: "full", priority: 2, trigger: "backfill" }, at(-10 * MIN));
      await r.tick(at(-10 * MIN));
      const gol = runner(tx, { retrieve: noSourceButAManual(GOL, MANUAL) });
      await gol.enqueue({ identity: GOL, kind: "full", priority: 0, trigger: "quote_open" });
      await gol.tick(at(2 * MIN));
      expect((await research(tx, ARGO)).state).toBe("waiting_manual");
      expect((await research(tx, GOL)).state).toBe("waiting_manual");

      const manual = await r.db.tx("quotes", (q) => claimNextManual(q, at(3 * MIN), MIN));
      expect(manual?.url).toBe(MANUAL);

      await tx.oilManualIngestion.updateMany({ data: { state: "ingested" } });
      const reading = await r.db.tx("quotes", (q) => claimNextReading(q, at(3 * MIN), MIN));
      expect(reading?.url).toBe(MANUAL);
    }));
  });

  describe("read-manuals: the budget, the run row, the release (D13, D19)", () => {
    /** An ingested manual with one stored page and a pending reading for `identity`. */
    async function pendingReading(tx: DbClient, identity: Identity, url: string) {
      await manualCandidate(tx, identity, url);
      await tx.oilManualIngestion.create({ data: { url, state: "ingested", attempts: 1 } });
      const document = await tx.oilManualDocument.create({ data: { url, sha256: url, bytes: 1, pages: 1, fetchedAt: NOW, fetchMs: 1, parseMs: 1 } });
      await tx.oilManualPage.create({ data: { documentId: document.id, pageNumber: 1, text: "Óleo do motor SAE 5W-40\nQuantidade de óleo do motor com filtro 4,0 litros" } });
      await tx.oilManualReading.create({ data: { url, ...identity, status: "pending" } });
    }

    const meteredPorts = (onSelect?: (signal: AbortSignal | undefined) => Promise<void>) => (options: { meter?: { onCall(event: unknown): void }; signal?: AbortSignal }) => ({
      selectPassage: async (source: never) => {
        options.meter?.onCall(modelCall(1_000));
        if (onSelect) await onSelect(options.signal);
        return { status: "selected" as const, source };
      },
      extract: async () => {
        if (options.signal?.aborted) throw new Error("aborted");
        options.meter?.onCall(modelCall(1_000));
        return { viscosityGrades: ["5W-40"], classification: "", fillLiters: 4, fillKind: "em_servico" as const, engineCoverage: "one" as const };
      },
    });

    it("writes a run row per reading with its cost, which counts toward the day's spend", inTx(async (tx) => {
      await pendingReading(tx, GOL, MANUAL);
      const db = trackedDb(tx);

      const result = await readNextManual({ db, portsFor: meteredPorts() as never, now: () => NOW, budgetUsd: 1 });

      expect(result.outcome).toBe("verified");
      const [row] = await tx.oilResearchRun.findMany({ where: { path: "reading" } });
      expect(row).toMatchObject({ kind: "manual_reading", researchId: null, identityKey: identityKey(GOL), outcome: "verified", glmCalls: 2 });
      expect(row!.costUsd.toNumber()).toBeGreaterThan(0);
      expect(await daySpendUsd(tx, NOW)).toBeCloseTo(row!.costUsd.toNumber(), 6);
    }));

    it("past the budget claims only a reading an identity waits on at priority 0 or 1", inTx(async (tx) => {
      await tx.oilResearchRun.create({ data: { id: "spent", identityKey: "x", kind: "full", trigger: "backfill", path: "search", startedAt: at(-MIN), finishedAt: at(-MIN), costUsd: 1 } });
      // A backfill identity waiting on its manual, and an attended one.
      await pendingReading(tx, ARGO, ARGO_MANUAL);
      await tx.oilResearch.create({ data: { id: "argo", identityKey: identityKey(ARGO)!, ...ARGO, state: "waiting_manual", priority: 2, trigger: "backfill", queuedAt: NOW, cycleQueuedAt: NOW, manualWaitUntil: at(30 * MIN) } });
      const db = trackedDb(tx);

      expect((await readNextManual({ db, portsFor: meteredPorts() as never, now: () => NOW, budgetUsd: 1 })).outcome).toBe("idle");

      await pendingReading(tx, GOL, MANUAL);
      await tx.oilResearch.create({ data: { id: "gol", identityKey: identityKey(GOL)!, ...GOL, state: "waiting_manual", priority: 0, trigger: "quote_open", queuedAt: NOW, cycleQueuedAt: NOW, manualWaitUntil: at(30 * MIN) } });
      const result = await readNextManual({ db, portsFor: meteredPorts() as never, now: () => NOW, budgetUsd: 1 });
      expect(result.outcome).toBe("verified");
      expect(await tx.oilManualReading.findFirstOrThrow({ where: { url: MANUAL } })).toMatchObject({ status: "verified" });
      expect(await tx.oilManualReading.findFirstOrThrow({ where: { url: ARGO_MANUAL } })).toMatchObject({ status: "pending" });
    }));

    it("puts a reading back to pending with its attempt refunded when the worker stops mid-reading", inTx(async (tx) => {
      await pendingReading(tx, GOL, MANUAL);
      const db = trackedDb(tx);
      const stop = new AbortController();

      const result = await readNextManual(
        {
          db,
          portsFor: meteredPorts(async (signal) => {
            stop.abort();
            expect(signal?.aborted).toBe(true);
          }) as never,
          now: () => NOW,
          budgetUsd: 1,
        },
        stop.signal,
      );

      expect(result.outcome).toBe("released");
      expect(await tx.oilManualReading.findFirstOrThrow({ where: { url: MANUAL } })).toMatchObject({ status: "pending", attempts: 0 });
      const [row] = await tx.oilResearchRun.findMany({ where: { path: "reading" } });
      expect(row).toMatchObject({ outcome: "released", glmCalls: 1 });
    }));

    it("closes a reading whose claim was lost as lost, with its spend counted toward the day", inTx(async (tx) => {
      await pendingReading(tx, GOL, MANUAL);
      const db = trackedDb(tx);

      const result = await readNextManual(
        {
          db,
          // Another worker claims the reading while the model reads it.
          portsFor: meteredPorts(async () => {
            await tx.oilManualReading.updateMany({ where: { url: MANUAL }, data: { attempts: { increment: 1 } } });
          }) as never,
          now: () => NOW,
          budgetUsd: 1,
        },
      );

      expect(result.outcome).toBe("lost");
      const [row] = await tx.oilResearchRun.findMany({ where: { path: "reading" } });
      expect(row).toMatchObject({ outcome: "lost", glmCalls: 2, finishedAt: NOW });
      expect(row!.costUsd.toNumber()).toBeGreaterThan(0);
      expect(await daySpendUsd(tx, NOW)).toBeCloseTo(row!.costUsd.toNumber(), 6);
    }));

    it("closes a reading that threw as lost, with the spend it had metered", inTx(async (tx) => {
      await pendingReading(tx, GOL, MANUAL);
      const db = trackedDb(tx);

      await expect(
        readNextManual({
          db,
          portsFor: ((options: { meter?: { onCall(event: unknown): void } }) => {
            options.meter?.onCall(modelCall(1_000));
            throw new Error("ports could not be built");
          }) as never,
          now: () => NOW,
          budgetUsd: 1,
        }),
      ).rejects.toThrow("ports could not be built");

      const [row] = await tx.oilResearchRun.findMany({ where: { path: "reading" } });
      expect(row).toMatchObject({ outcome: "lost", glmCalls: 1 });
      expect(await daySpendUsd(tx, NOW)).toBeGreaterThan(0);
    }));
  });

  describe("manual upgrades end (D11)", () => {
    it("runs an upgrade to its end, after which a sweep queues no new one", inTx(async (tx) => {
      const r = runner(tx, {});
      // A verified identity whose manual verified after its sources were read.
      await tx.oilResearch.create({
        data: { id: "gol", identityKey: identityKey(GOL)!, ...GOL, state: "verified", priority: 2, trigger: "adopted", outcome: "verified", queuedAt: at(-60 * MIN), cycleQueuedAt: at(-60 * MIN), finishedAt: at(-60 * MIN), sourcesReadAt: at(-60 * MIN), tecfilState: "ok" },
      });
      await tx.oilManualIngestion.create({ data: { url: MANUAL, state: "ingested", attempts: 1 } });
      await tx.oilManualReading.create({ data: { url: MANUAL, ...GOL, status: "pending" } });
      await readTheManual(tx, GOL, MANUAL, "verified", at(-MIN));
      const sweep = (now: Date) => sweepOilResearch({ db: r.db, settings: SETTINGS, keySet: () => true, searchAvailable: () => true, now: () => now });

      expect((await sweep(NOW)).upgraded).toEqual([identityKey(GOL)]);
      expect(await r.tick(NOW)).toMatchObject({ run: { outcome: "verified" } });
      const done = await research(tx, GOL);
      expect(done).toMatchObject({ state: "verified", kind: "manual_resolve", sourcesReadAt: NOW });

      // Included by the query's state filter, and read up to after the reading: nothing to do.
      expect((await sweep(at(MIN))).upgraded).toEqual([]);
      expect((await sweep(at(2 * MIN))).upgraded).toEqual([]);
    }));

    it("keeps a re-resolved no-source not searched when its stage 1 never searched", inTx(async (tx) => {
      const r = runner(tx, {}, { ...SETTINGS, manualIngestion: false });
      await tx.oilResearch.create({
        data: { id: "gol", identityKey: identityKey(GOL)!, ...GOL, state: "no_spec", searched: false, priority: 2, trigger: "backfill", outcome: "no_spec", queuedAt: at(-60 * MIN), cycleQueuedAt: at(-60 * MIN), finishedAt: at(-60 * MIN), sourcesReadAt: at(-60 * MIN) },
      });
      await r.enqueue({ identity: GOL, kind: "manual_resolve", priority: 1, trigger: "manual_upgrade" });

      expect(await r.tick()).toMatchObject({ run: { outcome: "no_spec" } });
      expect(await research(tx, GOL)).toMatchObject({ state: "no_spec", kind: "manual_resolve", searched: false });
    }));
  });
});
