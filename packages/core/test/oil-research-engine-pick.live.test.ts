/**
 * Test design (testing-strategy) — the dead ends in the runner (tasks 5.8, 5.9, 5.13)
 *
 * SUT: `quotes/run-oil-research`'s tick over ONE fake ports object, and the one enqueue, on a
 *   scratch database (a claim takes ANY due row, so rows another suite left would be claimed);
 *   each case runs in the rollback harness on it (module role: `quotes`).
 *
 * Oracle: `oil-research` "An engine pick re-reads the stored source for one engine" and "Every
 *   research outcome is recorded on the identity" (a clarification keeps its passages, a conflict
 *   its card data); `oil-attendant-fill` "A stored attendant volume never becomes a source";
 *   design D7 (the kinds' strength), D12 as amended (Tecfil for a conflict with cards), D14 (the
 *   engine-pick runs in neither sample), D24 G2.
 *
 * Cells (state | expected | the bug it would miss)
 *   an engine_pick claim          | exactly one extraction, over the copied passages, for the corrected identity; no retrieval, passage selection, search, Motul or escalation; a cache row cited to the passage; Tecfil | a new research; a cache row under the old identity
 *   one volume, no engine named   | verified with no liters (the missing volume)   | a volume guessed for the engine
 *   reopened no_spec, verifies    | verified                                        | the prior outcome kept over a verify
 *   reopened no_spec / clarification, does not verify | the prior outcome and payload, finished_at now | a resting answer replaced by a worse one
 *   a refetch of the earlier identity | the pick's copied passages unchanged       | the re-read emptied by another row
 *   queued engine_pick + quote-open | stays engine_pick                            | the pick downgraded to a full search
 *   queued engine_pick + refetch  | the refetch, the copy cleared                   | a refetch that never searches
 *   running engine_pick + refetch | pending_kind refetch                            | a refetch lost mid-run
 *   no vehicle carries the key    | held for the grace, then abandoned               | a pick abandoned before its version write
 *   25 answered engine_pick runs  | the search defaults                              | a re-read's minute polluting the estimate
 *   a clarification from a page   | passages with URL, tier, class and excerpt       | an engine pick with nothing to re-read
 *   a grade conflict              | card data, and Tecfil consulted                  | a conflict whose cards never price filters
 *   a grade conflict, no volume   | card data with volume null, and Tecfil           | a dead end with no way out (orchestrator 2026-10-01)
 *   a stored attendant volume     | never in a model's input or a cache row          | a typed volume laundered into a source
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { shouldRunLiveTests, type DbClient } from "@select-lub/core/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RetrievedSource } from "../src/modules/quotes/internal/pipeline/oil-spec.js";
import { createUsageMeter } from "../src/modules/quotes/internal/model-calls/meter.js";
import { DEFAULT_RUN_RANGES, loadPathTimings } from "../src/modules/quotes/internal/research/estimate.js";
import { identityKey } from "../src/modules/quotes/internal/research/identity-key.js";
import type { StoredPassage } from "../src/modules/quotes/internal/research/outcome.js";
import { ENGINE_PICK_ABANDON_GRACE_MS, enqueueResearch, type EnqueueRequest } from "../src/modules/quotes/internal/research/research-store.js";
import { createOutageBreaker, runOilResearchTick } from "../src/modules/quotes/run-oil-research/index.js";
import { withConnectRetry, withTestTransaction } from "../src/testing/index.js";
import { at, fakePorts, modelCall, MIN, NOW, page, SETTINGS, trackedDb, vehicle, type FakeScript } from "./oil-research-harness.js";
import { createScratchDatabase, type ScratchDatabase } from "./scratch-database.js";

const hasDatabase = shouldRunLiveTests();
const repoRoot = resolve(import.meta.dirname, "../../..");
const SCRATCH_SETUP_TIMEOUT_MS = 180_000;

const EARLIER = { make: "Toyota", year: 2019, model: "Corolla", version: "XEi" };
const CORRECTED = { ...EARLIER, version: "XEi 1.8 Dual VVT-i" };
const PASSAGE: StoredPassage = {
  publisher: "toyota.com.br",
  document: "Manual do proprietário Corolla 2019",
  page: "p. 412",
  url: "https://toyota.com.br/corolla-2019.pdf",
  tier: 1,
  classification: "manufacturer_manual",
  excerpt: "1.8 Dual VVT-i: 0W-20, 4,2 L com filtro. 2.0 Dynamic Force: 0W-16, 4,4 L com filtro.",
};

const pick = (identity = CORRECTED): EnqueueRequest => ({
  identity,
  kind: "engine_pick",
  priority: 0,
  trigger: "engine_pick",
  enginePick: { engine: "1.8 Dual VVT-i", from: identityKey(EARLIER)!, passages: [PASSAGE] },
});
const research = (tx: DbClient, identity: typeof EARLIER) => tx.oilResearch.findUniqueOrThrow({ where: { identityKey: identityKey(identity)! } });

describe.skipIf(!hasDatabase)("quotes/run-oil-research — the dead ends, on a scratch database", () => {
  let scratch: ScratchDatabase | undefined;
  let prisma!: PrismaClient;

  beforeAll(async () => {
    scratch = await createScratchDatabase(process.env.DATABASE_URL ?? "", "oil_research_engine_pick", repoRoot);
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

  function runner(tx: DbClient, script: FakeScript = {}) {
    const db = trackedDb(tx);
    const { ports, probe } = fakePorts(db, script);
    const breaker = createOutageBreaker(SETTINGS.outageBreaker);
    const tick = (now = NOW) => runOilResearchTick({ db, ports, settings: SETTINGS, now: () => now, breaker }, new AbortController().signal);
    const enqueue = (request: EnqueueRequest, now = NOW) => db.tx("quotes", (q) => enqueueResearch(q, request, now));
    return { probe, tick, enqueue };
  }

  /** An extractor that records what it was given and answers `spec`. */
  function recording(spec: Awaited<ReturnType<NonNullable<FakeScript["extract"]>>>) {
    const inputs: { source: RetrievedSource; version: string; engine?: string }[] = [];
    return {
      inputs,
      extract: (async (source, identity) => (inputs.push({ source, version: identity.version, ...(identity.engine ? { engine: identity.engine } : {}) }), spec)) as NonNullable<FakeScript["extract"]>,
    };
  }

  describe("an engine_pick run", () => {
    it("makes one extraction over the copied passages for the corrected identity, caches it there cited to the passage, and consults Tecfil", inTx(async (tx) => {
      await vehicle(tx, CORRECTED);
      const fake = recording({ viscosityGrades: ["0W-20"], classification: "", fillLiters: 4.2, fillKind: "em_servico", engineCoverage: "one" });
      const r = runner(tx, { extract: fake.extract });
      await r.enqueue(pick());

      const result = await r.tick();

      expect(result).toMatchObject({ outcome: "research", run: { outcome: "verified", state: "verified", tecfil: "ok" } });
      expect(r.probe.calls).toEqual(["extract", "tecfil"]);
      expect(fake.inputs).toHaveLength(1);
      // The picked engine reaches the extractor explicitly (orchestrator, 2026-10-01).
      expect(fake.inputs[0]).toMatchObject({ version: "XEi 1.8 Dual VVT-i", engine: "1.8 Dual VVT-i", source: { publisher: "toyota.com.br", url: PASSAGE.url, content: { kind: "text", text: PASSAGE.excerpt } } });
      const cache = await tx.motulCompatibility.findMany({ where: { model: "Corolla", year: 2019 } });
      expect(cache).toHaveLength(1);
      expect(cache[0]).toMatchObject({ version: "XEi 1.8 Dual VVT-i", viscosities: ["0W-20"], sourcePublisher: "toyota.com.br", sourceUrl: PASSAGE.url, sourceAuthority: 1 });
      expect(Number(cache[0]!.fillLiters)).toBe(4.2);
      const [run] = await tx.oilResearchRun.findMany({ where: { identityKey: identityKey(CORRECTED)! } });
      expect(run).toMatchObject({ path: "engine_pick", kind: "engine_pick", trigger: "engine_pick", outcome: "verified", glmCalls: 1, searchCalls: 0 });
      // The one extraction is metered: the run row's cost is what the fake meter was fed, at the list prices.
      const expected = createUsageMeter();
      expected.onCall(modelCall(500));
      expect(run!.costUsd.toNumber()).toBeCloseTo(expected.snapshot().costUsd, 6);
      expect(run!.costUsd.toNumber()).toBeGreaterThan(0);
      // It loaded no stored readings, so it moves no sources_read_at (orchestrator, 2026-10-01).
      expect(await research(tx, CORRECTED)).toMatchObject({ state: "verified", sourcesReadAt: null });
    }));

    it("records the missing volume when the passages give one volume without saying which engine it is for", inTx(async (tx) => {
      await vehicle(tx, CORRECTED);
      const r = runner(tx, { extract: async () => ({ viscosityGrades: ["0W-20"], classification: "", fillLiters: null, fillKind: null, engineCoverage: "one" }) });
      await r.enqueue(pick());

      await r.tick();

      expect(await research(tx, CORRECTED)).toMatchObject({ state: "verified" });
      const [cache] = await tx.motulCompatibility.findMany({ where: { model: "Corolla", version: CORRECTED.version } });
      expect(cache).toMatchObject({ fillLiters: null, viscosities: ["0W-20"] });
    }));

    it("replaces a reopened no-source with a verified re-read", inTx(async (tx) => {
      await vehicle(tx, CORRECTED);
      const r = runner(tx);
      await r.enqueue({ identity: CORRECTED, kind: "full", priority: 2, trigger: "backfill" }, at(-60 * MIN));
      await tx.oilResearch.update({ where: { identityKey: identityKey(CORRECTED)! }, data: { state: "no_spec", outcome: "no_spec", finishedAt: at(-30 * MIN) } });
      await r.enqueue(pick());

      await r.tick();

      expect(await research(tx, CORRECTED)).toMatchObject({ state: "verified", outcome: "verified" });
    }));

    it.each([
      ["no_spec", null],
      ["needs_clarification", { coverage: "mismatch", options: ["2.0"] }],
      ["conflicting_sources", { conflicts: [] }],
    ] as const)("keeps a reopened %s, dated by this run, when the re-read does not verify", (state, payload) =>
      withTestTransaction(prisma, async (tx) => {
        await vehicle(tx, CORRECTED);
        const r = runner(tx, { extract: async () => null });
        await r.enqueue({ identity: CORRECTED, kind: "full", priority: 2, trigger: "backfill" }, at(-60 * MIN));
        await tx.oilResearch.update({ where: { identityKey: identityKey(CORRECTED)! }, data: { state, outcome: state, outcomePayload: payload ?? undefined, finishedAt: at(-30 * MIN) } });
        await r.enqueue(pick());

        await r.tick();

        const row = await research(tx, CORRECTED);
        expect(row).toMatchObject({ state, outcome: state, finishedAt: NOW });
        if (payload) expect(row.outcomePayload).toEqual(payload);
        expect(await tx.motulCompatibility.count({ where: { model: "Corolla", version: CORRECTED.version } })).toBe(0);
      }),
    );

    it("keeps its copied passages when the earlier identity is fetched again", inTx(async (tx) => {
      const r = runner(tx);
      await r.enqueue({ identity: EARLIER, kind: "full", priority: 0, trigger: "quote_open" });
      await r.enqueue(pick());
      await r.enqueue({ identity: EARLIER, kind: "refetch", priority: 0, trigger: "refetch" });

      expect(await research(tx, CORRECTED)).toMatchObject({ kind: "engine_pick", enginePickPassages: [PASSAGE] });
    }));
  });

  describe("engine_pick in the one enqueue", () => {
    it("is kept when a quote-open's full research meets it queued", inTx(async (tx) => {
      const r = runner(tx);
      await r.enqueue(pick());
      await r.enqueue({ identity: CORRECTED, kind: "full", priority: 0, trigger: "quote_open" });

      expect(await research(tx, CORRECTED)).toMatchObject({ kind: "engine_pick", enginePickPassages: [PASSAGE] });
    }));

    it("becomes the refetch when a refetch meets it queued", inTx(async (tx) => {
      const r = runner(tx);
      await r.enqueue(pick());
      await r.enqueue({ identity: CORRECTED, kind: "refetch", priority: 0, trigger: "refetch" });

      expect(await research(tx, CORRECTED)).toMatchObject({ kind: "refetch", trigger: "refetch", enginePickPassages: null, enginePickEngine: null });
    }));

    it("takes a refetch mid-run as its pending kind", inTx(async (tx) => {
      const r = runner(tx);
      await r.enqueue(pick());
      await tx.oilResearch.update({ where: { identityKey: identityKey(CORRECTED)! }, data: { state: "running", attempts: 1, currentRunId: randomUUID(), leaseUntil: at(10 * MIN) } });
      await r.enqueue({ identity: CORRECTED, kind: "refetch", priority: 0, trigger: "refetch" });

      expect(await research(tx, CORRECTED)).toMatchObject({ state: "running", kind: "engine_pick", pendingKind: "refetch" });
    }));

    // Orchestrator, 2026-10-01: an engine re-read searched nothing.
    it("records an engine re-read that finds nothing as no source, not searched", inTx(async (tx) => {
      await vehicle(tx, CORRECTED);
      const r = runner(tx, { extract: async () => null });
      await r.enqueue(pick());

      await r.tick();

      expect(await research(tx, CORRECTED)).toMatchObject({ state: "no_spec", outcome: "no_spec", searched: false });
    }));

    // Orchestrator, 2026-10-01: the G1 fallback full gets the same grace and abandonment.
    it("holds the G1 fallback full research no vehicle carries for the grace, then abandons it", inTx(async (tx) => {
      const r = runner(tx);
      await r.enqueue({ identity: CORRECTED, kind: "full", priority: 0, trigger: "engine_pick" });

      expect(await r.tick()).toEqual({ outcome: "idle" });
      expect(await r.tick(at(ENGINE_PICK_ABANDON_GRACE_MS))).toMatchObject({ outcome: "abandoned" });
      expect(r.probe.calls).toEqual([]);
    }));

    // D12 as amended: a conflict with cards is claimed for Tecfil like a verified spec, and promoted alike.
    it("moves a conflict-with-cards row's pending Tecfil claim to the front on a quote-open", inTx(async (tx) => {
      const r = runner(tx);
      await r.enqueue({ identity: EARLIER, kind: "full", priority: 2, trigger: "backfill" }, at(-60 * MIN));
      await tx.oilResearch.update({
        where: { identityKey: identityKey(EARLIER)! },
        data: {
          state: "conflicting_sources",
          outcome: "conflicting_sources",
          outcomePayload: { conflicts: [], card: { viscosityGrades: ["0W-20"], classification: "", gradeSources: [], volume: null } },
          tecfilState: "pending",
          finishedAt: at(-30 * MIN),
        },
      });

      await r.enqueue({ identity: EARLIER, kind: "full", priority: 0, trigger: "quote_open" });

      expect(await research(tx, EARLIER)).toMatchObject({ state: "conflicting_sources", priority: 0, tecfilState: "pending" });
    }));

    it("holds a pick no vehicle carries for the grace, then abandons it", inTx(async (tx) => {
      const r = runner(tx);
      await r.enqueue(pick());

      expect(await r.tick()).toEqual({ outcome: "idle" });
      expect(await research(tx, CORRECTED)).toMatchObject({ state: "queued", dueAt: new Date(NOW.getTime() + ENGINE_PICK_ABANDON_GRACE_MS) });
      expect(await r.tick(at(ENGINE_PICK_ABANDON_GRACE_MS))).toMatchObject({ outcome: "abandoned" });
      expect(r.probe.calls).toEqual([]);
    }));
  });

  it("leaves engine_pick runs out of the search sample", inTx(async (tx) => {
    for (let i = 0; i < 25; i += 1) {
      await tx.oilResearchRun.create({
        data: { id: randomUUID(), identityKey: "k", kind: "engine_pick", trigger: "engine_pick", path: "engine_pick", outcome: "verified", startedAt: at(-60 * MIN + i * MIN), finishedAt: at(-59 * MIN + i * MIN + 30_000) },
      });
    }

    expect((await loadPathTimings(tx, "search", NOW)).range).toEqual(DEFAULT_RUN_RANGES.search);
    expect((await loadPathTimings(tx, "manual", NOW)).range).toEqual(DEFAULT_RUN_RANGES.manual);
  }));

  describe("what a research records for the dead ends", () => {
    it("keeps the passages a clarification read, with URL, tier, class and excerpt", inTx(async (tx) => {
      await vehicle(tx, EARLIER);
      const text = "Corolla 2019: 1.8 Dual VVT-i 0W-20 4,2 L; 2.0 Dynamic Force 0W-16 4,4 L";
      const r = runner(tx, {
        retrieve: async () => ({ status: "found", sources: [page("toyota.com.br", text, 1, "https://toyota.com.br/x")] }),
        extract: async () => ({ viscosityGrades: ["0W-20"], classification: "", fillLiters: null, fillKind: null, engineCoverage: "several", enginesNamed: ["1.8 Dual VVT-i", "2.0 Dynamic Force"] }),
      });
      await r.enqueue({ identity: EARLIER, kind: "full", priority: 0, trigger: "quote_open" });

      await r.tick();

      expect(await research(tx, EARLIER)).toMatchObject({
        state: "needs_clarification",
        outcomePayload: {
          coverage: "several",
          options: ["1.8 Dual VVT-i", "2.0 Dynamic Force"],
          passages: [{ publisher: "toyota.com.br", url: "https://toyota.com.br/x", tier: 1, classification: "manufacturer_manual", excerpt: text }],
        },
      });
    }));

    it("keeps a grade conflict's card data, and consults Tecfil for its cards", inTx(async (tx) => {
      await vehicle(tx, EARLIER);
      const r = runner(tx, {
        retrieve: async () => ({ status: "found", sources: [page("toyota.com.br", "0W-20 4,0 L", 1, "https://toyota.com.br/m"), page("CarroRac", "5W-40 4,0 L", 5)] }),
        extract: async (source) => ({ viscosityGrades: [source.publisher === "CarroRac" ? "5W-40" : "0W-20"], classification: "", fillLiters: 4, fillKind: "em_servico", engineCoverage: "one" }),
      });
      await r.enqueue({ identity: EARLIER, kind: "full", priority: 0, trigger: "quote_open" });

      const result = await r.tick();

      expect(result).toMatchObject({ run: { outcome: "conflicting_sources", tecfil: "ok" } });
      const row = await research(tx, EARLIER);
      expect(row).toMatchObject({
        state: "conflicting_sources",
        tecfilState: "ok",
        outcomePayload: {
          card: {
            viscosityGrades: ["0W-20", "5W-40"],
            gradeSources: [
              { grade: "0W-20", sourcePublisher: "toyota.com.br", sourceAuthority: 1, sourceUrl: "https://toyota.com.br/m", sourceClassification: "manufacturer_manual" },
              { grade: "5W-40", sourcePublisher: "CarroRac", sourceAuthority: 5, sourceUrl: null, sourceClassification: null },
            ],
            volume: { kind: "agreed", fillLiters: 4, fillCondition: "with_filter", source: { sourcePublisher: "toyota.com.br" } },
          },
        },
      });
      expect(await tx.tecfilCompatibility.count({ where: { model: "Corolla" } })).toBe(1);
    }));

    // Orchestrator, 2026-10-01: a grade conflict no source stated a volume for keeps its cards too.
    it("keeps a grade conflict's card data with no volume when no source stated one, and consults Tecfil", inTx(async (tx) => {
      await vehicle(tx, EARLIER);
      const r = runner(tx, {
        retrieve: async () => ({ status: "found", sources: [page("toyota.com.br", "0W-20", 1, "https://toyota.com.br/m"), page("CarroRac", "5W-40", 5)] }),
        extract: async (source) => ({ viscosityGrades: [source.publisher === "CarroRac" ? "5W-40" : "0W-20"], classification: "", fillLiters: null, fillKind: null, engineCoverage: "one" }),
      });
      await r.enqueue({ identity: EARLIER, kind: "full", priority: 0, trigger: "quote_open" });

      expect(await r.tick()).toMatchObject({ run: { outcome: "conflicting_sources", tecfil: "ok" } });
      const row = await research(tx, EARLIER);
      expect(row).toMatchObject({ state: "conflicting_sources", tecfilState: "ok", outcomePayload: { card: { viscosityGrades: ["0W-20", "5W-40"], volume: null } } });
    }));

    it("never hands a stored attendant volume to a model or writes it on a cache row", inTx(async (tx) => {
      const car = await vehicle(tx, EARLIER);
      const user = await tx.user.create({ data: { id: randomUUID(), email: `${randomUUID()}@t.local`, name: "Marina" } });
      await tx.oilAttendantFill.create({ data: { id: randomUUID(), identityKey: identityKey(EARLIER)!, ...EARLIER, liters: 7.77, recordedByUserId: user.id } });
      const fake = recording({ viscosityGrades: ["0W-20"], classification: "", fillLiters: null, fillKind: null, engineCoverage: "one" });
      const r = runner(tx, { extract: fake.extract });
      await r.enqueue({ identity: EARLIER, kind: "full", priority: 0, trigger: "quote_open" });

      await r.tick();

      expect(fake.inputs.length).toBeGreaterThan(0);
      expect(JSON.stringify(fake.inputs)).not.toMatch(/7[.,]77/);
      const [cache] = await tx.motulCompatibility.findMany({ where: { model: "Corolla" } });
      expect(cache).toMatchObject({ fillLiters: null });
      expect(car.id).toBeTruthy();
    }));
  });
});
