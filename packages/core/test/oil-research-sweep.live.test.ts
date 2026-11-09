/**
 * Test design (testing-strategy) — the research sweep, on a scratch database
 *
 * SUT: `quotes/sweep-oil-research`'s `sweepOilResearch`, through the slice's entry point: the
 *   vehicles it enqueues, their priority, the watermark, adoption through the one enqueue, the
 *   manual-upgrade check, the end of manual waits, and the heartbeat. Module role: `quotes`.
 *
 * Why a scratch database: the first sweep reads EVERY vehicle, and the demo seed's would be
 *   queued with the test's.
 *
 * Oracle: background-oil-research D7, D9, D11 and task 3.2's Verify list; `oil-research`
 *   "Every complete vehicle identity is researched in the background" and "A manual found by the
 *   search is waited for, within a bound".
 */
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { shouldRunLiveTests, type DbClient } from "@select-lub/core/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityKey } from "../src/modules/quotes/internal/research/identity-key.js";
import { enqueueResearch, type EnqueueRequest } from "../src/modules/quotes/internal/research/research-store.js";
import { readRunnerStatus } from "../src/modules/quotes/internal/research/runner-row.js";
import { sweepOilResearch } from "../src/modules/quotes/sweep-oil-research/index.js";
import { withConnectRetry, withTestTransaction } from "../src/testing/index.js";
import { at, MIN, NOW, readingSpec, SETTINGS, trackedDb, vehicle } from "./oil-research-harness.js";
import { createScratchDatabase, type ScratchDatabase } from "./scratch-database.js";

const hasDatabase = shouldRunLiveTests();
const repoRoot = resolve(import.meta.dirname, "../../..");
const SCRATCH_SETUP_TIMEOUT_MS = 180_000;
const DAY = 24 * 60 * MIN;

const GOL = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0 FLEX 12V 4P" };
const ARGO = { make: "Fiat", year: 2022, model: "Argo", version: "1.3 Drive" };
const ONIX = { make: "Chevrolet", year: 2019, model: "Onix", version: "1.4 LT" };
type Identity = typeof GOL;
const key = (identity: Identity) => identityKey(identity)!;
const research = (tx: DbClient, identity: Identity) => tx.oilResearch.findUnique({ where: { identityKey: key(identity) } });

describe.skipIf(!hasDatabase)("quotes/sweep-oil-research — live, on a scratch database", () => {
  let scratch: ScratchDatabase | undefined;
  let prisma!: PrismaClient;

  beforeAll(async () => {
    scratch = await createScratchDatabase(process.env.DATABASE_URL ?? "", "oil_research_sweep", repoRoot);
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

  function sweeper(tx: DbClient) {
    const db = trackedDb(tx);
    const sweep = (now = NOW) => sweepOilResearch({ db, settings: SETTINGS, keySet: () => true, searchAvailable: () => true, now: () => now });
    const enqueue = (request: EnqueueRequest, now = NOW) => db.tx("quotes", (q) => enqueueResearch(q, request, now));
    return { db, sweep, enqueue };
  }

  /** A watermark just before the case's vehicles, so only they are read. */
  const watermark = (tx: DbClient, at: Date) => tx.oilResearchRunner.create({ data: { id: "runner", sweepWatermark: at } });

  it("queues a settled complete vehicle, not one updated 30 s ago, and never an incomplete one", inTx(async (tx) => {
    const s = sweeper(tx);
    await watermark(tx, at(-DAY));
    await vehicle(tx, GOL, at(-5 * MIN));
    await vehicle(tx, ARGO, at(-30_000));
    await vehicle(tx, { make: "", year: 2019, model: "Onix", version: "1.4 LT" }, at(-5 * MIN));
    const customer = await tx.customer.create({ data: { origin: "CRM", status: "ACTIVE" } });
    await tx.vehicle.create({ data: { customerId: customer.id, origin: "ERP", model: "Onix", plate: "ABC1D23", createdAt: at(-5 * MIN), updatedAt: at(-5 * MIN) } });

    const result = await s.sweep();

    expect(result.enqueued).toEqual([key(GOL)]);
    expect(await research(tx, GOL)).toMatchObject({ state: "queued", priority: 1, trigger: "registration" });
    expect(await research(tx, ARGO)).toBeNull();
    expect(await tx.oilResearch.count()).toBe(1);
    // A minute later ARGO has settled.
    expect((await s.sweep(at(2 * MIN))).enqueued).toEqual([key(ARGO)]);
  }));

  it("makes one row of two vehicles with one identity, spelled differently", inTx(async (tx) => {
    const s = sweeper(tx);
    await watermark(tx, at(-DAY));
    await vehicle(tx, GOL, at(-5 * MIN));
    await vehicle(tx, { ...GOL, make: "VOLKSWAGEN", version: "1.0 flex 12v 4p" }, at(-4 * MIN));

    await s.sweep();

    expect(await tx.oilResearch.count()).toBe(1);
  }));

  it("adopts an adoptable verified identity as verified, with Tecfil ok or pending, and queues a historical one", inTx(async (tx) => {
    const s = sweeper(tx);
    await watermark(tx, at(-DAY));
    for (const identity of [GOL, ARGO, ONIX]) await vehicle(tx, identity, at(-5 * MIN));
    const cited = { sourcePublisher: "vw.com.br", sourceDocument: "Manual", sourcePage: "p. 3" };
    await tx.motulCompatibility.create({ data: { ...GOL, viscosities: ["5W-40"], viscosity: "5W-40", classification: "", ...cited, consultedAt: at(-DAY) } });
    await tx.tecfilCompatibility.create({ data: { ...GOL, manufacturerLabel: "VW", vehicleLabel: "Gol", matchedBy: {}, oilFilters: [], fuelFilters: [], consultedAt: at(-DAY) } });
    await tx.motulCompatibility.create({ data: { ...ARGO, viscosities: ["0W-20"], viscosity: "0W-20", classification: "", ...cited, consultedAt: at(-DAY) } });
    // Historical: a single viscosity, no provenance.
    await tx.motulCompatibility.create({ data: { ...ONIX, viscosity: "5W-30", classification: "", sourcePublisher: "", sourceDocument: "", sourcePage: "", consultedAt: at(-DAY) } });

    await s.sweep();

    expect(await research(tx, GOL)).toMatchObject({ state: "verified", trigger: "adopted", tecfilState: "ok", sourcesReadAt: at(-DAY) });
    expect(await research(tx, ARGO)).toMatchObject({ state: "verified", trigger: "adopted", tecfilState: "pending" });
    expect(await research(tx, ONIX)).toMatchObject({ state: "queued" });
  }));

  it("backfills on the first sweep: recent vehicles at priority 1, the rest at 2; the watermark advances", inTx(async (tx) => {
    const s = sweeper(tx);
    await vehicle(tx, GOL, at(-2 * DAY));
    await vehicle(tx, ARGO, at(-3 * 60 * MIN));

    const result = await s.sweep();

    expect(await research(tx, GOL)).toMatchObject({ priority: 2, trigger: "backfill" });
    expect(await research(tx, ARGO)).toMatchObject({ priority: 1, trigger: "registration" });
    expect(result.watermark).toEqual(at(-SETTINGS.settleMs));
    expect((await readRunnerStatus(tx))?.sweepWatermark).toEqual(at(-SETTINGS.settleMs));
    // The next sweep reads nothing already read.
    expect((await s.sweep(at(MIN))).vehicles).toBe(0);
  }));

  it("lowers a backfill identity to registration priority when a car carrying it is registered", inTx(async (tx) => {
    const s = sweeper(tx);
    await vehicle(tx, GOL, at(-2 * DAY));
    await s.sweep(at(-60 * MIN));
    expect(await research(tx, GOL)).toMatchObject({ priority: 2 });

    await vehicle(tx, GOL, at(-5 * MIN));
    await s.sweep();

    expect(await research(tx, GOL)).toMatchObject({ priority: 1, requestedAt: NOW });
  }));

  it("moves a waiting identity on once its readings ended — a refused URL included — or its deadline passed", inTx(async (tx) => {
    const s = sweeper(tx);
    await watermark(tx, at(-DAY));
    const waiting = (identity: Identity, id: string, until: Date) =>
      tx.oilResearch.create({ data: { id, identityKey: key(identity), ...identity, state: "waiting_manual", priority: 0, trigger: "quote_open", queuedAt: at(-MIN), cycleQueuedAt: at(-MIN), requestedAt: at(-MIN), waitStartedAt: at(-MIN), manualWaitUntil: until } });
    await waiting(GOL, "gol", at(30 * MIN));
    await waiting(ARGO, "argo", at(30 * MIN));
    await waiting(ONIX, "onix", at(-1));
    await tx.oilManualIngestion.create({ data: { url: "https://vw.com.br/gol.pdf", state: "refused", definite: true } });
    await tx.oilManualReading.create({ data: { url: "https://vw.com.br/gol.pdf", ...GOL, status: "pending" } });
    await tx.oilManualIngestion.create({ data: { url: "https://fiat.com.br/argo.pdf", state: "pending" } });
    await tx.oilManualReading.create({ data: { url: "https://fiat.com.br/argo.pdf", ...ARGO, status: "pending" } });
    await tx.oilManualIngestion.create({ data: { url: "https://gm.com.br/onix.pdf", state: "pending" } });
    await tx.oilManualReading.create({ data: { url: "https://gm.com.br/onix.pdf", ...ONIX, status: "pending" } });

    const result = await s.sweep();

    expect(result.waitsEnded.sort()).toEqual([key(GOL), key(ONIX)].sort());
    expect(await research(tx, GOL)).toMatchObject({ state: "queued", kind: "manual_resolve", trigger: "wait_ended", priority: 0 });
    expect(await research(tx, ARGO)).toMatchObject({ state: "waiting_manual" });
    expect(await research(tx, ONIX)).toMatchObject({ state: "queued", kind: "manual_resolve" });
  }));

  it("upgrades an identity whose reading verified after its sources were read, and not one read before", inTx(async (tx) => {
    const s = sweeper(tx);
    await watermark(tx, at(-DAY));
    const verified = (identity: Identity, id: string, sourcesReadAt: Date) =>
      tx.oilResearch.create({ data: { id, identityKey: key(identity), ...identity, state: "verified", priority: 2, trigger: "adopted", outcome: "verified", queuedAt: at(-DAY), cycleQueuedAt: at(-DAY), finishedAt: at(-DAY), sourcesReadAt, tecfilState: "ok" } });
    const reading = async (identity: Identity, url: string, readAt: Date) => {
      await tx.oilManualIngestion.create({ data: { url, state: "ingested", attempts: 1 } });
      await tx.oilManualReading.create({ data: { url, ...identity, status: "verified", readAt, citedPage: "p. 3", excerpt: "5W-40 4,0 litros", spec: readingSpec(["5W-40"], 4) } });
    };
    // An adopted row: its sources were read when its cache row was consulted.
    await verified(GOL, "gol", at(-DAY));
    await reading(GOL, "https://vw.com.br/gol.pdf", at(-60 * MIN));
    await verified(ARGO, "argo", at(-60 * MIN));
    await reading(ARGO, "https://fiat.com.br/argo.pdf", at(-DAY));

    const result = await s.sweep();

    expect(result.upgraded).toEqual([key(GOL)]);
    expect(await research(tx, GOL)).toMatchObject({ state: "queued", kind: "manual_resolve", trigger: "manual_upgrade", priority: 1 });
    expect(await research(tx, ARGO)).toMatchObject({ state: "verified" });
    // The upgrade runs and records, reading its sources after the reading verified: from that
    // verified state, which the query includes, a later sweep queues nothing more.
    await tx.oilResearch.update({ where: { id: "gol" }, data: { state: "verified", kind: "manual_resolve", sourcesReadAt: at(MIN) } });
    expect((await s.sweep(at(2 * MIN))).upgraded).toEqual([]);
    // Positive control: the same verified state read up to before the reading is upgraded again.
    await tx.oilResearch.update({ where: { id: "gol" }, data: { sourcesReadAt: at(-2 * 60 * MIN) } });
    expect((await s.sweep(at(3 * MIN))).upgraded).toEqual([key(GOL)]);
  }));

  it("upgrades a failed identity only for a reading verified after its last attempt started", inTx(async (tx) => {
    const s = sweeper(tx);
    await watermark(tx, at(-DAY));
    // Failed after three outages; an outage keeps the old sources_read_at (here: none at all).
    await tx.oilResearch.create({
      data: { id: "gol", identityKey: key(GOL), ...GOL, state: "failed", priority: 0, trigger: "quote_open", outcome: "failed", attempts: 3, queuedAt: at(-DAY), cycleQueuedAt: at(-DAY), finishedAt: at(-30 * MIN) },
    });
    const attempt = (id: string, startedAt: Date) =>
      tx.oilResearchRun.create({ data: { id, researchId: "gol", identityKey: key(GOL), kind: "full", trigger: "quote_open", path: "search", startedAt, finishedAt: new Date(startedAt.getTime() + 60_000), outcome: "unavailable" } });
    await attempt("first", at(-60 * MIN));
    await attempt("last", at(-40 * MIN));
    await tx.oilManualIngestion.create({ data: { url: "https://vw.com.br/gol.pdf", state: "ingested", attempts: 1 } });
    // Verified before the last attempt started: that attempt read it.
    await tx.oilManualReading.create({ data: { url: "https://vw.com.br/gol.pdf", ...GOL, status: "verified", readAt: at(-45 * MIN), citedPage: "p. 3", excerpt: "5W-40 4,0 litros", spec: readingSpec(["5W-40"], 4) } });

    expect((await s.sweep()).upgraded).toEqual([]);

    // Verified during the last attempt (after it started, before the cycle failed): it upgrades.
    await tx.oilManualReading.updateMany({ where: { model: "Gol" }, data: { readAt: at(-35 * MIN) } });
    expect((await s.sweep(at(MIN))).upgraded).toEqual([key(GOL)]);
  }));

  it("queues an old vehicle updated today at backfill priority: only a created one is a registration", inTx(async (tx) => {
    const s = sweeper(tx);
    await watermark(tx, at(-DAY));
    const customer = await tx.customer.create({ data: { origin: "CRM", status: "ACTIVE" } });
    // Created a year ago; the ERP pull touched it an hour ago.
    await tx.vehicle.create({ data: { customerId: customer.id, origin: "ERP", ...GOL, createdAt: at(-365 * DAY), updatedAt: at(-60 * MIN) } });

    await s.sweep();

    expect(await research(tx, GOL)).toMatchObject({ state: "queued", priority: 2, trigger: "backfill", requestedAt: null });
  }));

  it("gives a running identity the upgrade as its pending cycle", inTx(async (tx) => {
    const s = sweeper(tx);
    await watermark(tx, at(-DAY));
    await tx.oilResearch.create({ data: { id: "gol", identityKey: key(GOL), ...GOL, state: "running", kind: "full", priority: 0, trigger: "quote_open", attempts: 1, currentRunId: "run", leaseUntil: at(10 * MIN), queuedAt: at(-DAY), cycleQueuedAt: at(-DAY), sourcesReadAt: at(-DAY) } });
    await tx.oilManualIngestion.create({ data: { url: "https://vw.com.br/gol.pdf", state: "ingested", attempts: 1 } });
    await tx.oilManualReading.create({ data: { url: "https://vw.com.br/gol.pdf", ...GOL, status: "verified", readAt: at(-MIN), citedPage: "p. 3", excerpt: "5W-40 4,0 litros", spec: readingSpec(["5W-40"], 4) } });

    await s.sweep();

    expect(await research(tx, GOL)).toMatchObject({ state: "running", attempts: 1, currentRunId: "run", pendingKind: "manual_resolve", pendingPriority: 1 });
  }));

  it("refreshes the runner's heartbeat on every sweep, while a run is in progress too", inTx(async (tx) => {
    const s = sweeper(tx);
    await watermark(tx, at(-DAY));
    await tx.oilResearch.create({ data: { id: "gol", identityKey: key(GOL), ...GOL, state: "running", priority: 0, trigger: "quote_open", attempts: 1, currentRunId: "run", leaseUntil: at(10 * MIN), queuedAt: NOW, cycleQueuedAt: NOW } });

    await s.sweep();
    expect(await readRunnerStatus(tx)).toMatchObject({ lastSeenAt: NOW, keySet: true, searchAvailable: true });
    await s.sweep(at(MIN));
    expect(await readRunnerStatus(tx)).toMatchObject({ lastSeenAt: at(MIN) });
  }));
});
