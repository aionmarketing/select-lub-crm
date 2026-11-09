/**
 * Test design (testing-strategy) — the research store, on a scratch database
 *
 * SUT: `internal/research/research-store.ts` (the one enqueue, the claims, the compare-and-set
 *   writes, the expired-lease sweep), `budget.ts`'s day sum and `runner-row.ts`, each called
 *   under the `quotes` role (`db.tx("quotes", …)`) on the real schema and grants.
 *
 * Why a scratch database: a claim takes ANY due row and the runner-row lock, so rows another
 *   suite left in the shared database would be claimed here, and ours by a dev worker there.
 *   Most cases roll back (`withTestTransaction`); the concurrency cases must commit on two
 *   connections, and delete what they wrote.
 *
 * Oracle: background-oil-research D7 (the enqueue table), D8 (order, pace, budget, one at a
 *   time), D9 (claim, lease, compare-and-set), D10 (cycles and attempts), D12 (Tecfil's own
 *   claim), D13 (the day's spend), D14 (the stored estimate), and `oil-research`'s scenarios.
 *   Task 2.3's and 2.4's Verify lists, one case each; the estimate's live half (2.5) too.
 *
 * Fixed clock: every store call takes `now`, so no case depends on the wall clock; the SQL
 *   clock is used only for `created_at` defaults, which nothing asserts.
 */
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { shouldRunLiveTests } from "@select-lub/core/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbClient } from "../src/kernel/db.js";
import type { MotulCompatibility, TecfilCompatibility } from "../src/modules/quotes/contracts/http.js";
import { createUsageMeter } from "../src/modules/quotes/internal/model-calls/meter.js";
import { daySpendUsd } from "../src/modules/quotes/internal/research/budget.js";
import { expectedMinutes, loadPathTimings } from "../src/modules/quotes/internal/research/estimate.js";
import { identityKey } from "../src/modules/quotes/internal/research/identity-key.js";
import {
  claimNextResearch,
  endManualWait,
  enqueueResearch,
  recordResearch,
  recordTecfil,
  releaseResearch,
  renewResearchLease,
  renewTecfilLease,
  sweepExpiredLeases,
  type ClaimResult,
  type EnqueueRequest,
  type ResearchClaim,
  type TecfilClaim,
} from "../src/modules/quotes/internal/research/research-store.js";
import { pauseForProvider, readRunnerStatus, researchStopped, writeRunnerHeartbeat } from "../src/modules/quotes/internal/research/runner-row.js";
import { runInTransactionOnTx, withConnectRetry, withTestTransaction } from "../src/testing/index.js";
import { createScratchDatabase, type ScratchDatabase } from "./scratch-database.js";

const hasDatabase = shouldRunLiveTests();
const repoRoot = resolve(import.meta.dirname, "../../..");
const SCRATCH_SETUP_TIMEOUT_MS = 180_000;

const NOW = new Date("2026-09-26T15:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const LEASE_MS = 12 * MIN;
const OPTIONS = { leaseMs: LEASE_MS, budgetUsd: 1, paceMs: MIN };

const POLO = { make: "Volkswagen", year: 2020, model: "Polo", version: "1.0 TSI" };
const GOL = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0 FLEX 12V 4P" };
const ARGO = { make: "Fiat", year: 2022, model: "Argo", version: "1.3 Drive" };
const ONIX = { make: "Chevrolet", year: 2019, model: "Onix", version: "1.4 LT" };
type Identity = typeof POLO;
const keyOf = (identity: Identity) => identityKey(identity)!;

const quoteOpen = (identity: Identity): EnqueueRequest => ({ identity, kind: "full", priority: 0, trigger: "quote_open" });
const refetch = (identity: Identity): EnqueueRequest => ({ identity, kind: "refetch", priority: 0, trigger: "refetch" });
const registration = (identity: Identity): EnqueueRequest => ({ identity, kind: "full", priority: 1, trigger: "registration" });
const backfill = (identity: Identity): EnqueueRequest => ({ identity, kind: "full", priority: 2, trigger: "backfill" });
const upgrade = (identity: Identity): EnqueueRequest => ({ identity, kind: "manual_resolve", priority: 1, trigger: "manual_upgrade" });

/** Runs `fn` under the quotes role, as a slice would. */
const asQuotes = <T,>(tx: DbClient, fn: (tx: DbClient) => Promise<T>) => createDb(tx, runInTransactionOnTx(tx)).tx("quotes", fn);
/** The enqueue alone: a sweep-triggered cycle with no vehicle behind it is abandoned at claim. */
const enqueueOnly = (tx: DbClient, request: EnqueueRequest, now = NOW) => asQuotes(tx, (q) => enqueueResearch(q, request, now));
/** The enqueue, with a vehicle carrying the identity when the sweep is the caller, as the sweep's would be. */
async function enqueue(tx: DbClient, request: EnqueueRequest, now = NOW) {
  if (request.trigger === "registration" || request.trigger === "backfill") await vehicle(tx, request.identity as Identity);
  return enqueueOnly(tx, request, now);
}
const claim = (tx: DbClient, now = NOW, options: Partial<typeof OPTIONS> = {}) => asQuotes(tx, (q) => claimNextResearch(q, { now, ...OPTIONS, ...options }));
const research = (tx: DbClient, identity: Identity) => tx.oilResearch.findUniqueOrThrow({ where: { identityKey: keyOf(identity) } });

function asResearch(result: ClaimResult): ResearchClaim {
  if (result.type !== "research") throw new Error(`expected a research claim, got ${result.type}`);
  return result;
}
function asTecfil(result: ClaimResult | TecfilClaim | null): TecfilClaim {
  if (!result || result.type !== "tecfil") throw new Error(`expected a Tecfil claim, got ${result?.type ?? "null"}`);
  return result;
}

/** A verified cache row with provenance and a grade list: adoptable (D7). */
async function adoptableCache(tx: DbClient, identity: Identity, consultedAt: Date, overrides: Record<string, unknown> = {}) {
  await tx.motulCompatibility.create({
    data: { ...identity, viscosities: ["5W-30"], viscosity: "5W-30", classification: "API SP", sourcePublisher: "vw.com.br", sourceDocument: "Manual", sourcePage: "p. 3", consultedAt, ...overrides },
  });
}

async function tecfilCache(tx: DbClient, identity: Identity) {
  await tx.tecfilCompatibility.create({
    data: { ...identity, manufacturerLabel: "VW", vehicleLabel: identity.model, matchedBy: {}, oilFilters: [], fuelFilters: [], consultedAt: NOW },
  });
}

async function vehicle(tx: DbClient, identity: Identity) {
  const customer = await tx.customer.create({ data: { origin: "CRM", status: "ACTIVE" } });
  await tx.vehicle.create({ data: { customerId: customer.id, origin: "CRM", ...identity } });
}

const cacheRow = (identity: Identity): Omit<MotulCompatibility, "id"> => ({
  ...identity,
  viscosityGrades: ["5W-40"],
  viscosity: "5W-40",
  classification: "",
  fillLiters: 4,
  fillKind: "em_servico",
  consultedAt: NOW.toISOString(),
  rawPayload: null,
  sourcePublisher: "vw.com.br",
  sourceDocument: "Manual Gol 2021",
  sourcePage: "p. 3",
  sourceAuthority: 1,
  sourceUrl: null,
});

const tecfilRow = (identity: Identity): Omit<TecfilCompatibility, "id"> => ({
  ...identity,
  application: { manufacturer: "VW", vehicle: identity.model, engine: null },
  matchedBy: { manufacturer: "exact", vehicle: "exact", engine: "exact" },
  oilFilters: [],
  fuelFilters: [],
  consultedAt: NOW.toISOString(),
  rawPayload: null,
});

/** A meter fed `usd` of one call, at the list price of gpt-6.1-sol's output (US$ 10 per million). */
function meterWorth(usd: number) {
  const meter = createUsageMeter();
  meter.onCall({ model: "gpt-6.1-sol", usage: { input: 0, cachedInput: 0, reasoning: 0, output: Math.round((usd / 10) * 1e6) }, timedOut: false, accepted: true });
  return meter.snapshot();
}

/** A finished run row, for the budget and the estimate. */
async function runRow(tx: DbClient, data: { path?: string; kind?: string; trigger?: string; outcome?: string; startedAt: Date; ms?: number; costUsd?: number; queuedAt?: Date; waitStartedAt?: Date; researchModel?: string | null }) {
  await tx.oilResearchRun.create({
    data: {
      id: `run-${Math.random().toString(36).slice(2)}`,
      identityKey: "fixture",
      kind: data.kind ?? "full",
      trigger: data.trigger ?? "backfill",
      path: data.path ?? "search",
      outcome: data.outcome ?? "verified",
      startedAt: data.startedAt,
      finishedAt: new Date(data.startedAt.getTime() + (data.ms ?? 100_000)),
      costUsd: data.costUsd ?? 0,
      queuedAt: data.queuedAt ?? null,
      waitStartedAt: data.waitStartedAt ?? null,
      researchModel: data.researchModel === undefined ? "openai:gpt-6.1-sol:medium" : data.researchModel,
    },
  });
}

describe.skipIf(!hasDatabase)("oil research store — live, on a scratch database", () => {
  let scratch: ScratchDatabase | undefined;
  let prisma!: PrismaClient;

  beforeAll(async () => {
    scratch = await createScratchDatabase(process.env.DATABASE_URL ?? "", "oil_research_store", repoRoot);
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
  /** Deletes what a committing case wrote. */
  async function cleanUp() {
    await prisma.oilResearchRun.deleteMany({});
    await prisma.oilResearch.deleteMany({});
    await prisma.oilResearchRunner.deleteMany({});
  }

  describe("claims", () => {
    it("lets exactly one of two concurrent claims take the one due identity", async () => {
      try {
        await prisma.oilResearchRunner.create({ data: { id: "runner" } });
        await prisma.$transaction((tx) => enqueue(tx, quoteOpen(POLO)));
        let firstClaimed!: (result: ClaimResult) => void;
        const firstClaim = new Promise<ClaimResult>((done) => (firstClaimed = done));
        let releaseFirst!: () => void;
        const firstHolds = new Promise<void>((done) => (releaseFirst = done));
        const first = prisma.$transaction(
          async (tx) => {
            firstClaimed(await claim(tx));
            await firstHolds;
          },
          { timeout: 60_000, maxWait: 30_000 },
        );
        let second: ClaimResult | undefined;
        try {
          expect((await firstClaim).type).toBe("research");
          const secondRun = prisma.$transaction(async (tx) => {
            second = await claim(tx);
          }, { timeout: 60_000, maxWait: 30_000 });
          // The second waits on the runner-row lock while the first holds it.
          await new Promise((done) => setTimeout(done, 500));
          releaseFirst();
          await first;
          await secondRun;
        } finally {
          releaseFirst();
          await first.catch(() => undefined);
        }
        // The second waited on the runner-row lock and then saw the first's live lease.
        expect(second?.type).toBe("busy");
        const row = await research(prisma, POLO);
        expect(row).toMatchObject({ state: "running", attempts: 1 });
        expect(await prisma.oilResearchRun.count()).toBe(1);
      } finally {
        await cleanUp();
      }
    });

    it("claims exactly one row under the plan that makes a plain IN subquery over-claim", inTx(async (tx) => {
      // Queued one second apart, so the heap order is the claim order: the rescanned IN form
      // then meets each next row as the outer scan reaches it, which is what over-claims.
      for (const [i, identity] of [POLO, GOL, ARGO].entries()) await enqueue(tx, backfill(identity), at(i * 1000 - HOUR));
      await tx.$executeRaw`SET LOCAL plan_cache_mode = force_generic_plan`;
      await tx.$executeRaw`SET LOCAL enable_material = off`;
      await tx.$executeRaw`SET LOCAL enable_hashjoin = off`;
      await tx.$executeRaw`SET LOCAL enable_mergejoin = off`;
      await tx.$executeRaw`SET LOCAL enable_hashagg = off`;
      await tx.$executeRaw`SET LOCAL enable_sort = off`;
      // Positive control: the plain IN form, under the same plan, takes more than its LIMIT.
      await tx.$executeRaw`SAVEPOINT control`;
      const control = await tx.$queryRaw<{ id: string }[]>`
        UPDATE oil_research SET state = 'running'
        WHERE id IN (SELECT id FROM oil_research WHERE state = 'queued' ORDER BY priority, requested_at NULLS LAST, queued_at, id LIMIT ${1} FOR UPDATE SKIP LOCKED)
        RETURNING id`;
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT control`;
      expect(control.length).toBeGreaterThan(1);

      expect((await claim(tx)).type).toBe("research");
      expect(await tx.oilResearch.count({ where: { state: "running" } })).toBe(1);
      expect(await tx.oilResearch.count({ where: { state: "queued" } })).toBe(2);
    }));

    it("never has two identities running when two claimers each have one due", async () => {
      try {
        // The runner row already exists, so nothing but its FOR UPDATE lock serialises the claimers.
        await prisma.oilResearchRunner.create({ data: { id: "runner" } });
        await prisma.$transaction((tx) => enqueue(tx, quoteOpen(POLO)));
        await prisma.$transaction((tx) => enqueue(tx, quoteOpen(GOL)));
        const results = await Promise.all([0, 1].map(() => prisma.$transaction((tx) => claim(tx), { timeout: 60_000, maxWait: 30_000 })));
        expect(results.map((result) => result.type).sort()).toEqual(["busy", "research"]);
        expect(await prisma.oilResearch.count({ where: { state: "running" } })).toBe(1);
      } finally {
        await cleanUp();
      }
    });

    it("claims priority 0 before 1 before 2, and within 0 the earlier requested_at", inTx(async (tx) => {
      await enqueue(tx, backfill(ARGO), at(-4 * MIN));
      await enqueue(tx, registration(ONIX), at(-3 * MIN));
      await enqueue(tx, quoteOpen(GOL), at(-1 * MIN));
      await enqueue(tx, quoteOpen(POLO), at(-2 * MIN));
      const order: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const claimed = asResearch(await claim(tx));
        order.push(claimed.identityKey);
        // Out of the way, so the next claim is not busy.
        await tx.oilResearch.update({ where: { id: claimed.id }, data: { state: "no_spec" } });
      }
      expect(order).toEqual([keyOf(POLO), keyOf(GOL), keyOf(ONIX), keyOf(ARGO)]);
    }));

    it("counts the attempt, stamps the lease and requested_at, stores the estimate and inserts the run row", inTx(async (tx) => {
      await enqueue(tx, backfill(POLO), at(-HOUR));
      const claimed = asResearch(await claim(tx));
      const row = await research(tx, POLO);
      expect(row).toMatchObject({ state: "running", attempts: 1, currentRunId: claimed.runId, startedAt: NOW, requestedAt: NOW, leaseUntil: at(LEASE_MS) });
      // A backfill claim with nobody waiting: requested_at is the claim, so the defaults 1–5 min.
      expect(expectedMinutes({ minS: row.expectedMinS!, maxS: row.expectedMaxS! })).toEqual({ min: 1, max: 5 });
      const run = await tx.oilResearchRun.findUniqueOrThrow({ where: { id: claimed.runId } });
      expect(run).toMatchObject({ researchId: row.id, identityKey: keyOf(POLO), kind: "full", trigger: "backfill", path: "search", startedAt: NOW, finishedAt: null });
      // Fixed at claim, before any model call (switch-oil-research-to-openai D7).
      expect(run.researchModel).toBe("openai:gpt-6.1-sol:medium");
    }));

    it("paces the backfill: a priority-2 row waits until the pace has passed since the last run", inTx(async (tx) => {
      await runRow(tx, { startedAt: at(-2 * MIN), ms: 90_000 }); // finished 30 s ago
      await enqueue(tx, backfill(POLO));
      expect((await claim(tx)).type).toBe("idle");
      expect((await claim(tx, at(30_000))).type).toBe("research");
    }));

    it("claims a priority-0 row at once, whatever the pace", inTx(async (tx) => {
      await runRow(tx, { startedAt: at(-2 * MIN), ms: 110_000 });
      await enqueue(tx, quoteOpen(POLO));
      expect((await claim(tx)).type).toBe("research");
    }));

    it("does not claim a queued row before its backoff is due", inTx(async (tx) => {
      await enqueue(tx, quoteOpen(POLO));
      const claimed = asResearch(await claim(tx));
      await asQuotes(tx, (q) => recordResearch(q, claimed, { outcome: "transient" }, { now: NOW, leaseMs: LEASE_MS }));
      expect(await research(tx, POLO)).toMatchObject({ state: "queued", attempts: 1, dueAt: at(5 * MIN) });
      expect((await claim(tx, at(4 * MIN))).type).toBe("idle");
      expect(asResearch(await claim(tx, at(5 * MIN))).attempts).toBe(2);
    }));
  });

  describe("the one enqueue", () => {
    it("inserts an absent identity queued at the caller's priority and kind, attempts 0", inTx(async (tx) => {
      const result = await enqueue(tx, quoteOpen(POLO));
      expect(result).toMatchObject({ status: "written", row: { inserted: true, state: "queued", priority: 0, kind: "full" } });
      const row = await research(tx, POLO);
      expect(row).toMatchObject({ state: "queued", kind: "full", priority: 0, trigger: "quote_open", attempts: 0, requestedAt: NOW, queuedAt: NOW, cycleQueuedAt: NOW, make: "Volkswagen" });
      expect(expectedMinutes({ minS: row.expectedMinS!, maxS: row.expectedMaxS! })).toEqual({ min: 1, max: 5 });
    }));

    it("leaves a backfill row without requested_at or an estimate", inTx(async (tx) => {
      await enqueue(tx, backfill(POLO));
      expect(await research(tx, POLO)).toMatchObject({ priority: 2, requestedAt: null, expectedMinS: null });
    }));

    it("writes nothing for an incomplete identity", inTx(async (tx) => {
      expect(await enqueue(tx, quoteOpen({ ...POLO, version: " " }))).toEqual({ status: "incomplete" });
      expect(await tx.oilResearch.count()).toBe(0);
    }));

    it("shares one row between spellings of one identity", inTx(async (tx) => {
      await enqueue(tx, backfill(POLO));
      await enqueue(tx, backfill({ ...POLO, make: "VOLKSWAGEN", version: "1.0 tsi" }));
      expect(await tx.oilResearch.count()).toBe(1);
    }));

    it("adopts an adoptable cache row on insert: verified, Tecfil ok when its row exists", inTx(async (tx) => {
      const consultedAt = at(-3 * 24 * HOUR);
      await adoptableCache(tx, POLO, consultedAt);
      await tecfilCache(tx, POLO);
      await adoptableCache(tx, GOL, consultedAt);
      await enqueue(tx, backfill(POLO));
      await enqueue(tx, quoteOpen(GOL));
      expect(await research(tx, POLO)).toMatchObject({ state: "verified", trigger: "adopted", outcome: "verified", sourcesReadAt: consultedAt, tecfilState: "ok", attempts: 0 });
      expect(await research(tx, GOL)).toMatchObject({ state: "verified", trigger: "adopted", tecfilState: "pending", priority: 0, tecfilDueAt: null });
      expect(await tx.oilResearchRun.count()).toBe(0);
    }));

    it.each([
      ["null viscosities (a pre-grounding row)", { viscosities: undefined }],
      ["an empty source_publisher", { sourcePublisher: "" }],
    ])("does not adopt a cache row with %s", async (_label, overrides) =>
      withTestTransaction(prisma, async (tx) => {
        await adoptableCache(tx, POLO, at(-HOUR), overrides);
        await enqueue(tx, quoteOpen(POLO));
        expect(await research(tx, POLO)).toMatchObject({ state: "queued", priority: 0 });
      }));

    it("queues a refetch of an absent identity even with an adoptable row", inTx(async (tx) => {
      await adoptableCache(tx, POLO, at(-HOUR));
      await enqueue(tx, refetch(POLO));
      expect(await research(tx, POLO)).toMatchObject({ state: "queued", kind: "refetch", trigger: "refetch" });
    }));

    it("lowers a queued priority-2 row to 1 on a registration, and sets requested_at", inTx(async (tx) => {
      await enqueue(tx, backfill(POLO), at(-HOUR));
      await enqueue(tx, registration(POLO));
      expect(await research(tx, POLO)).toMatchObject({ priority: 1, trigger: "registration", requestedAt: NOW, queuedAt: at(-HOUR) });
    }));

    it("turns a queued manual_resolve into a refetch, due now with attempts 0", inTx(async (tx) => {
      await enqueue(tx, upgrade(POLO), at(-HOUR));
      await tx.oilResearch.update({ where: { identityKey: keyOf(POLO) }, data: { attempts: 1, dueAt: at(5 * MIN) } });
      await enqueue(tx, refetch(POLO));
      const row = await research(tx, POLO);
      // A cycle of its own: requested anew, and its estimate stored (D7, D14).
      expect(row).toMatchObject({ state: "queued", kind: "refetch", priority: 0, attempts: 0, dueAt: null, cycleQueuedAt: NOW, requestedAt: NOW });
      expect(expectedMinutes({ minS: row.expectedMinS!, maxS: row.expectedMaxS! })).toEqual({ min: 1, max: 5 });
    }));

    it("gives a running row a refetch as its pending cycle, and the recorder queues it", inTx(async (tx) => {
      await enqueue(tx, backfill(POLO), at(-HOUR));
      const claimed = asResearch(await claim(tx, at(-10 * MIN)));
      await enqueue(tx, refetch(POLO), at(-MIN));
      expect(await research(tx, POLO)).toMatchObject({ state: "running", attempts: 1, currentRunId: claimed.runId, kind: "full", pendingKind: "refetch", pendingPriority: 0, pendingRequestedAt: at(-MIN) });

      const recorded = await asQuotes(tx, (q) => recordResearch(q, claimed, { outcome: "no_spec", searched: true, sourcesReadAt: at(-9 * MIN) }, { now: NOW, leaseMs: LEASE_MS }));
      expect(recorded).toMatchObject({ status: "recorded", state: "queued" });
      expect(await research(tx, POLO)).toMatchObject({
        state: "queued",
        kind: "refetch",
        trigger: "refetch",
        priority: 0,
        attempts: 0,
        requestedAt: at(-MIN),
        outcome: "no_spec",
        pendingKind: null,
        pendingPriority: null,
      });
    }));

    it("writes nothing when a refetch arrives on a running refetch", inTx(async (tx) => {
      await enqueue(tx, refetch(POLO));
      asResearch(await claim(tx));
      const before = await research(tx, POLO);
      expect(await enqueue(tx, refetch(POLO), at(MIN))).toMatchObject({ status: "unchanged" });
      expect((await research(tx, POLO)).updatedAt).toEqual(before.updatedAt);
    }));

    it("ends a wait on a refetch, and only lowers its priority on a quote-open", inTx(async (tx) => {
      await enqueue(tx, backfill(POLO));
      const claimed = asResearch(await claim(tx));
      await asQuotes(tx, (q) => recordResearch(q, claimed, { outcome: "waiting_manual", waitUntil: at(30 * MIN), sourcesReadAt: NOW }, { now: NOW, leaseMs: LEASE_MS }));
      await enqueue(tx, quoteOpen(POLO), at(MIN));
      expect(await research(tx, POLO)).toMatchObject({ state: "waiting_manual", priority: 0, requestedAt: NOW, manualWaitUntil: at(30 * MIN) });

      await enqueue(tx, refetch(POLO), at(2 * MIN));
      expect(await research(tx, POLO)).toMatchObject({ state: "queued", kind: "refetch", priority: 0, attempts: 0, waitStartedAt: null, manualWaitUntil: null, requestedAt: at(2 * MIN) });
    }));

    it("starts a new cycle on a verified row for a refetch or a manual upgrade, and nothing else", inTx(async (tx) => {
      await adoptableCache(tx, POLO, at(-HOUR));
      await tecfilCache(tx, POLO);
      await enqueue(tx, backfill(POLO));
      expect(await enqueue(tx, quoteOpen(POLO))).toMatchObject({ status: "unchanged" });
      expect(await enqueue(tx, registration(POLO))).toMatchObject({ status: "unchanged" });
      await enqueue(tx, upgrade(POLO));
      expect(await research(tx, POLO)).toMatchObject({ state: "queued", kind: "manual_resolve", trigger: "manual_upgrade", priority: 1, attempts: 0 });
    }));

    it("promotes a verified row's due Tecfil claim to priority 0 on a quote-open, and changes nothing else", inTx(async (tx) => {
      await adoptableCache(tx, POLO, at(-HOUR));
      await enqueue(tx, backfill(POLO));
      const before = await research(tx, POLO);
      await enqueue(tx, quoteOpen(POLO), at(MIN));
      const after = await research(tx, POLO);
      expect(after).toMatchObject({ state: "verified", priority: 0, tecfilState: "pending", attempts: before.attempts, tecfilAttempts: 0, requestedAt: null });
    }));

    it("writes nothing on a quote-open of a verified row whose Tecfil is ok", inTx(async (tx) => {
      await adoptableCache(tx, POLO, at(-HOUR));
      await tecfilCache(tx, POLO);
      await enqueue(tx, backfill(POLO));
      const before = await research(tx, POLO);
      expect(await enqueue(tx, quoteOpen(POLO), at(MIN))).toMatchObject({ status: "unchanged" });
      expect((await research(tx, POLO)).updatedAt).toEqual(before.updatedAt);
    }));

    /** A resting row with `state`, finished at `finishedAt`. */
    async function resting(tx: DbClient, state: string, finishedAt: Date, extra: Record<string, unknown> = {}) {
      await enqueue(tx, backfill(POLO), at(-30 * 24 * HOUR));
      await tx.oilResearch.update({ where: { identityKey: keyOf(POLO) }, data: { state, outcome: state, finishedAt, attempts: 3, ...extra } });
    }

    it.each([
      ["no_spec before the miss window", "no_spec", -7 * 24 * HOUR + MIN, {}, quoteOpen, "no_spec"],
      ["no_spec after the miss window", "no_spec", -8 * 24 * HOUR, {}, quoteOpen, "queued"],
      ["no_spec not searched, at once while the runner can search", "no_spec", -HOUR, { searched: false, runnerSearch: true }, quoteOpen, "queued"],
      // Orchestrator ruling, review of #188: not while it cannot, or every poll would re-queue it.
      ["no_spec not searched, while the runner cannot search", "no_spec", -HOUR, { searched: false, runnerSearch: false }, quoteOpen, "no_spec"],
      ["failed before 24 h", "failed", -23 * HOUR, {}, quoteOpen, "failed"],
      ["failed after 24 h", "failed", -25 * HOUR, {}, quoteOpen, "queued"],
      ["a clarification on a quote-open", "needs_clarification", -30 * 24 * HOUR, {}, quoteOpen, "needs_clarification"],
      ["a clarification on a refetch", "needs_clarification", -HOUR, {}, refetch, "queued"],
      ["a conflict on a manual upgrade", "conflicting_sources", -HOUR, {}, upgrade, "queued"],
      ["a conflict on the sweep", "conflicting_sources", -30 * 24 * HOUR, {}, registration, "conflicting_sources"],
      ["abandoned, on the sweep", "abandoned", -HOUR, {}, backfill, "queued"],
      ["failed, on the sweep", "failed", -30 * 24 * HOUR, {}, backfill, "failed"],
    ] as const)("re-runs a resting row by D10's policy: %s", async (_label, state, finished, extra, request, expected) =>
      withTestTransaction(prisma, async (tx) => {
        const { runnerSearch, ...columns } = extra as Record<string, unknown> & { runnerSearch?: boolean };
        if (runnerSearch !== undefined) {
          await tx.oilResearchRunner.create({ data: { id: "runner", lastSeenAt: NOW, keySet: true, searchAvailable: runnerSearch } });
        }
        await resting(tx, state, at(finished), columns);
        await enqueue(tx, request(POLO));
        const row = await research(tx, POLO);
        expect(row.state).toBe(expected);
        if (expected === "queued") {
          // A new cycle: attempts 0, due now, stamped now.
          expect(row).toMatchObject({ attempts: 0, dueAt: null, cycleQueuedAt: NOW, queuedAt: NOW });
        } else {
          expect(row.attempts).toBe(3);
        }
      }));

    it("gives a failed identity re-enqueued after 24 h its three attempts", inTx(async (tx) => {
      await resting(tx, "failed", at(-25 * HOUR));
      await enqueue(tx, quoteOpen(POLO));
      for (const attempt of [1, 2, 3]) {
        const claimed = asResearch(await claim(tx, at(attempt * HOUR)));
        expect(claimed.attempts).toBe(attempt);
        await asQuotes(tx, (q) => recordResearch(q, claimed, { outcome: "transient" }, { now: at(attempt * HOUR), leaseMs: LEASE_MS }));
      }
      expect(await research(tx, POLO)).toMatchObject({ state: "failed", outcome: "failed", attempts: 3 });
    }));

    it("writes nothing on a repeat enqueue that changes nothing", inTx(async (tx) => {
      await enqueue(tx, quoteOpen(POLO));
      const before = await research(tx, POLO);
      for (const request of [quoteOpen(POLO), registration(POLO), backfill(POLO)]) {
        expect(await enqueue(tx, request, at(3_000))).toMatchObject({ status: "unchanged" });
      }
      const after = await research(tx, POLO);
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(after).toEqual(before);
    }));

    it("answers two concurrent quote-open enqueues of one new key with one row and no P2002", async () => {
      try {
        const results = await Promise.all([0, 1].map(() => prisma.$transaction((tx) => enqueue(tx, quoteOpen(POLO)), { timeout: 60_000, maxWait: 30_000 })));
        expect(results.map((result) => result.status).sort()).toEqual(["unchanged", "written"]);
        expect(await prisma.oilResearch.count()).toBe(1);
      } finally {
        await cleanUp();
      }
    });

    it("sets requested_at on a promotion from priority 2, and does not move it on a second promotion, a retry or the wait", inTx(async (tx) => {
      await enqueue(tx, backfill(POLO), at(-3 * 24 * HOUR));
      await enqueue(tx, registration(POLO), at(-10 * MIN));
      await enqueue(tx, quoteOpen(POLO), at(-5 * MIN));
      expect(await research(tx, POLO)).toMatchObject({ priority: 0, requestedAt: at(-10 * MIN) });

      const first = asResearch(await claim(tx, at(-4 * MIN)));
      await asQuotes(tx, (q) => recordResearch(q, first, { outcome: "transient" }, { now: at(-3 * MIN), leaseMs: LEASE_MS }));
      const second = asResearch(await claim(tx, at(2 * MIN)));
      await asQuotes(tx, (q) => recordResearch(q, second, { outcome: "waiting_manual", waitUntil: at(30 * MIN), sourcesReadAt: NOW }, { now: at(3 * MIN), leaseMs: LEASE_MS }));
      await asQuotes(tx, (q) => endManualWait(q, second.id, at(4 * MIN)));
      const third = asResearch(await claim(tx, at(5 * MIN)));
      expect(third).toMatchObject({ kind: "manual_resolve", path: "manual", requestedAt: at(-10 * MIN), waitStartedAt: at(3 * MIN) });
      expect(await research(tx, POLO)).toMatchObject({ requestedAt: at(-10 * MIN), trigger: "wait_ended", attempts: 1 });
    }));
  });

  describe("adoption and abandonment at claim", () => {
    it("adopts a cache row written after the cycle was queued, with no run row", inTx(async (tx) => {
      await enqueue(tx, backfill(POLO), at(-HOUR));
      await adoptableCache(tx, POLO, at(-MIN));
      await vehicle(tx, POLO);
      expect(await claim(tx)).toMatchObject({ type: "adopted", identityKey: keyOf(POLO) });
      expect(await research(tx, POLO)).toMatchObject({ state: "verified", trigger: "adopted", sourcesReadAt: at(-MIN), tecfilState: "pending", attempts: 0 });
      expect(await tx.oilResearchRun.count()).toBe(0);
    }));

    it("abandons a backfill cycle of a key no vehicle carries, and researches a quote-open cycle of it", inTx(async (tx) => {
      await vehicle(tx, { ...GOL, model: "Polo" }); // same year, another model
      await enqueueOnly(tx, backfill(GOL));
      expect(await claim(tx)).toMatchObject({ type: "abandoned", identityKey: keyOf(GOL) });
      expect(await research(tx, GOL)).toMatchObject({ state: "abandoned", outcome: "abandoned", attempts: 0 });
      expect(await tx.oilResearchRun.count()).toBe(0);

      await enqueue(tx, quoteOpen(GOL));
      expect((await claim(tx)).type).toBe("research");
    }));

    it("researches a backfill cycle while a vehicle carries the key in another spelling", inTx(async (tx) => {
      await vehicle(tx, { ...GOL, make: "VOLKSWAGEN" });
      await enqueueOnly(tx, backfill(GOL));
      expect((await claim(tx)).type).toBe("research");
    }));
  });

  describe("compare-and-set writes", () => {
    it("records a verified spec with its cache row and takes over the Tecfil claim", inTx(async (tx) => {
      await enqueue(tx, quoteOpen(GOL));
      const claimed = asResearch(await claim(tx));
      const recorded = await asQuotes(tx, (q) => recordResearch(q, claimed, { outcome: "verified", cacheRow: cacheRow(GOL), sourcesReadAt: NOW, incomplete: true }, { now: at(MIN), leaseMs: LEASE_MS, meter: meterWorth(0.02) }));
      expect(recorded).toMatchObject({ status: "recorded", state: "verified", runOutcome: "verified" });
      const tecfil = asTecfil(recorded.status === "recorded" ? recorded.tecfil : null);
      expect(tecfil).toMatchObject({ takeover: true, runId: claimed.runId, tecfilAttempts: 1 });
      expect(await research(tx, GOL)).toMatchObject({ state: "verified", outcome: "verified", attempts: 1, tecfilState: "running", tecfilLeaseUntil: at(MIN + LEASE_MS), leaseUntil: null });
      expect(await tx.motulCompatibility.count()).toBe(1);
      expect(await tx.oilResearchRun.findUniqueOrThrow({ where: { id: claimed.runId } })).toMatchObject({ outcome: "verified", incomplete: true, finishedAt: at(MIN) });

      expect(await asQuotes(tx, (q) => recordTecfil(q, tecfil, { state: "ok", row: tecfilRow(GOL) }, { now: at(2 * MIN) }))).toBe(true);
      expect(await research(tx, GOL)).toMatchObject({ state: "verified", tecfilState: "ok", tecfilAttempts: 0, attempts: 1 });
      expect(await tx.tecfilCompatibility.count()).toBe(1);
    }));

    it("writes nothing to the identity, the run or the cache after a lost claim", inTx(async (tx) => {
      await enqueue(tx, quoteOpen(GOL));
      const claimed = asResearch(await claim(tx));
      // Another worker's claim of the identity since: a new run id.
      await tx.oilResearch.update({ where: { id: claimed.id }, data: { currentRunId: "another-run" } });
      const before = await research(tx, GOL);
      const meter = meterWorth(0.05);
      expect(await asQuotes(tx, (q) => renewResearchLease(q, claimed, at(MIN), LEASE_MS, { meter }))).toBe(false);
      expect(await asQuotes(tx, (q) => recordResearch(q, claimed, { outcome: "verified", cacheRow: cacheRow(GOL), sourcesReadAt: NOW }, { now: at(MIN), leaseMs: LEASE_MS, meter }))).toEqual({ status: "lost" });
      expect(await asQuotes(tx, (q) => releaseResearch(q, claimed, { now: at(MIN), meter }))).toBe(false);
      expect(await research(tx, GOL)).toEqual(before);
      expect(await tx.motulCompatibility.count()).toBe(0);
      expect(await tx.oilResearchRun.findUniqueOrThrow({ where: { id: claimed.runId } })).toMatchObject({ finishedAt: null, outcome: null, glmCalls: 0 });
    }));

    it("adds at most one cache row per claim", inTx(async (tx) => {
      await enqueue(tx, quoteOpen(GOL));
      const claimed = asResearch(await claim(tx));
      const verified = { outcome: "verified", cacheRow: cacheRow(GOL), sourcesReadAt: NOW } as const;
      expect((await asQuotes(tx, (q) => recordResearch(q, claimed, verified, { now: at(MIN), leaseMs: LEASE_MS }))).status).toBe("recorded");
      expect(await asQuotes(tx, (q) => recordResearch(q, claimed, verified, { now: at(2 * MIN), leaseMs: LEASE_MS }))).toEqual({ status: "lost" });
      expect(await tx.motulCompatibility.count()).toBe(1);
    }));

    it("renews the lease and flushes the meter to the run row", inTx(async (tx) => {
      await enqueue(tx, quoteOpen(GOL));
      const claimed = asResearch(await claim(tx));
      expect(await asQuotes(tx, (q) => renewResearchLease(q, claimed, at(5 * MIN), LEASE_MS, { meter: meterWorth(0.03), stageMs: { webSearch: 4200 } }))).toBe(true);
      expect(await research(tx, GOL)).toMatchObject({ leaseUntil: at(5 * MIN + LEASE_MS) });
      const run = await tx.oilResearchRun.findUniqueOrThrow({ where: { id: claimed.runId } });
      expect(run).toMatchObject({ glmCalls: 1, stageMs: { webSearch: 4200 }, finishedAt: null });
      expect(run.costUsd.toNumber()).toBeCloseTo(0.03, 6);
    }));

    it("refunds the attempt on a release, and books the run as released with its spend", inTx(async (tx) => {
      await enqueue(tx, quoteOpen(GOL));
      const claimed = asResearch(await claim(tx));
      expect(await asQuotes(tx, (q) => releaseResearch(q, claimed, { now: at(MIN), meter: meterWorth(0.04), dueAt: at(2 * MIN) }))).toBe(true);
      expect(await research(tx, GOL)).toMatchObject({ state: "queued", attempts: 0, dueAt: at(2 * MIN), leaseUntil: null });
      const run = await tx.oilResearchRun.findUniqueOrThrow({ where: { id: claimed.runId } });
      expect(run).toMatchObject({ outcome: "released", finishedAt: at(MIN) });
      expect(run.costUsd.toNumber()).toBeCloseTo(0.04, 6);
    }));

    it("queues an expired lease with attempts left, and fails one with none", inTx(async (tx) => {
      await enqueue(tx, quoteOpen(GOL));
      const first = asResearch(await claim(tx));
      await asQuotes(tx, (q) => sweepExpiredLeases(q, at(LEASE_MS)));
      expect(await research(tx, GOL)).toMatchObject({ state: "queued", attempts: 1, dueAt: null, leaseUntil: null });
      expect(await tx.oilResearchRun.findUniqueOrThrow({ where: { id: first.runId } })).toMatchObject({ outcome: "lost", finishedAt: at(LEASE_MS) });

      await tx.oilResearch.update({ where: { id: first.id }, data: { attempts: 2 } });
      const last = asResearch(await claim(tx, at(LEASE_MS)));
      expect(last.attempts).toBe(3);
      await asQuotes(tx, (q) => sweepExpiredLeases(q, at(2 * LEASE_MS)));
      expect(await research(tx, GOL)).toMatchObject({ state: "failed", outcome: "failed", attempts: 3, finishedAt: at(2 * LEASE_MS) });
    }));

    it("leaves a verified row verified when its Tecfil is claimed, with its spec attempts and lease unchanged", inTx(async (tx) => {
      await adoptableCache(tx, POLO, at(-HOUR));
      await enqueue(tx, quoteOpen(POLO));
      const before = await research(tx, POLO);
      const tecfil = asTecfil(await claim(tx));
      expect(tecfil).toMatchObject({ takeover: false, tecfilAttempts: 1 });
      expect(await research(tx, POLO)).toMatchObject({ state: "verified", attempts: before.attempts, leaseUntil: before.leaseUntil, tecfilState: "running", currentRunId: tecfil.runId, tecfilLeaseUntil: at(LEASE_MS) });
      expect(await tx.oilResearchRun.findUniqueOrThrow({ where: { id: tecfil.runId } })).toMatchObject({ kind: "tecfil_only", path: "tecfil" });
      expect(await asQuotes(tx, (q) => renewTecfilLease(q, tecfil, at(MIN), LEASE_MS))).toBe(true);
      expect(await asQuotes(tx, (q) => recordTecfil(q, tecfil, { state: "unavailable" }, { now: at(2 * MIN) }))).toBe(true);
      expect(await research(tx, POLO)).toMatchObject({ state: "verified", attempts: before.attempts, tecfilState: "unavailable", tecfilDueAt: at(2 * MIN + 15 * MIN), tecfilAttempts: 1 });
      expect(await tx.oilResearchRun.findUniqueOrThrow({ where: { id: tecfil.runId } })).toMatchObject({ outcome: "unavailable", finishedAt: at(2 * MIN) });
    }));

    it("leaves a crashed Tecfil claim's identity verified, its Tecfil pending and due now, and never queued", inTx(async (tx) => {
      await adoptableCache(tx, POLO, at(-HOUR));
      await enqueue(tx, quoteOpen(POLO));
      const tecfil = asTecfil(await claim(tx));
      const swept = await asQuotes(tx, (q) => sweepExpiredLeases(q, at(LEASE_MS)));
      expect(swept).toEqual({ research: 0, tecfil: 1 });
      expect(await research(tx, POLO)).toMatchObject({ state: "verified", attempts: 0, tecfilState: "pending", tecfilDueAt: null, tecfilLeaseUntil: null });
      expect(await tx.oilResearchRun.findUniqueOrThrow({ where: { id: tecfil.runId } })).toMatchObject({ outcome: "lost" });
      expect(asTecfil(await claim(tx, at(LEASE_MS))).tecfilAttempts).toBe(2);
    }));

    it("blocks a research claim of another identity while a Tecfil lease is live", inTx(async (tx) => {
      await adoptableCache(tx, POLO, at(-HOUR));
      await enqueue(tx, quoteOpen(POLO));
      asTecfil(await claim(tx));
      await enqueue(tx, quoteOpen(GOL));
      expect((await claim(tx, at(MIN))).type).toBe("busy");
    }));

    it("writes nothing for a Tecfil write whose current_run_id no longer matches", inTx(async (tx) => {
      await adoptableCache(tx, POLO, at(-HOUR));
      await enqueue(tx, quoteOpen(POLO));
      const tecfil = asTecfil(await claim(tx));
      await tx.oilResearch.update({ where: { id: tecfil.id }, data: { currentRunId: "another-run" } });
      const before = await research(tx, POLO);
      expect(await asQuotes(tx, (q) => renewTecfilLease(q, tecfil, at(MIN), LEASE_MS))).toBe(false);
      expect(await asQuotes(tx, (q) => recordTecfil(q, tecfil, { state: "ok", row: tecfilRow(POLO) }, { now: at(MIN) }))).toBe(false);
      expect(await research(tx, POLO)).toEqual(before);
      expect(await tx.tecfilCompatibility.count()).toBe(0);
    }));

    it("guards the Tecfil step a verified record took over: a lost run id writes no Tecfil row and the spec stays verified", inTx(async (tx) => {
      await enqueue(tx, quoteOpen(GOL));
      const claimed = asResearch(await claim(tx));
      const recorded = await asQuotes(tx, (q) => recordResearch(q, claimed, { outcome: "verified", cacheRow: cacheRow(GOL), sourcesReadAt: NOW }, { now: at(MIN), leaseMs: LEASE_MS }));
      const tecfil = asTecfil(recorded.status === "recorded" ? recorded.tecfil : null);
      await asQuotes(tx, (q) => sweepExpiredLeases(q, at(MIN + LEASE_MS)));
      asTecfil(await claim(tx, at(MIN + LEASE_MS)));
      expect(await asQuotes(tx, (q) => recordTecfil(q, tecfil, { state: "ok", row: tecfilRow(GOL) }, { now: at(MIN + LEASE_MS) }))).toBe(false);
      expect(await tx.tecfilCompatibility.count()).toBe(0);
      expect(await research(tx, GOL)).toMatchObject({ state: "verified", attempts: 1 });
    }));

    it("records a clarification on the last attempt's transient outcome, and failed without one", inTx(async (tx) => {
      await enqueue(tx, quoteOpen(GOL));
      await tx.oilResearch.update({ where: { identityKey: keyOf(GOL) }, data: { attempts: 2 } });
      const last = asResearch(await claim(tx));
      const payload = { coverage: "several", options: ["1.0", "1.6"] };
      await asQuotes(tx, (q) => recordResearch(q, last, { outcome: "transient", fallback: { outcome: "needs_clarification", payload } }, { now: at(MIN), leaseMs: LEASE_MS }));
      expect(await research(tx, GOL)).toMatchObject({ state: "needs_clarification", outcome: "needs_clarification", outcomePayload: payload, finishedAt: at(MIN) });
    }));

    it("stores no_spec as not searched when the web search could not run", inTx(async (tx) => {
      await enqueue(tx, quoteOpen(GOL));
      const claimed = asResearch(await claim(tx));
      await asQuotes(tx, (q) => recordResearch(q, claimed, { outcome: "no_spec", searched: false, sourcesReadAt: NOW }, { now: at(MIN), leaseMs: LEASE_MS }));
      expect(await research(tx, GOL)).toMatchObject({ state: "no_spec", searched: false, sourcesReadAt: NOW });
    }));
  });

  describe("review of #185", () => {
    it("never erases a provider pause committed while a heartbeat runs", async () => {
      try {
        await prisma.oilResearchRunner.create({ data: { id: "runner" } });
        let releasePause!: () => void;
        const pauseHolds = new Promise<void>((done) => (releasePause = done));
        let paused!: () => void;
        const pauseWritten = new Promise<void>((done) => (paused = done));
        // Connection A pauses for the provider and holds its transaction open.
        const pause = prisma.$transaction(
          async (tx) => {
            await asQuotes(tx, (q) => pauseForProvider(q, NOW, at(15 * MIN)));
            paused();
            await pauseHolds;
          },
          { timeout: 60_000, maxWait: 30_000 },
        );
        let heartbeat: Promise<unknown> | undefined;
        try {
          await pauseWritten;
          // Connection B's heartbeat starts meanwhile; unlocked, it would read no pause and then
          // overwrite A's once A committed.
          heartbeat = prisma.$transaction((tx) => asQuotes(tx, (q) => writeRunnerHeartbeat(q, { now: at(MIN), keySet: true, searchAvailable: true, budgetUsd: 1 })), { timeout: 60_000, maxWait: 30_000 });
          await new Promise((done) => setTimeout(done, 500));
        } finally {
          releasePause();
          await pause;
          await heartbeat;
        }
        expect(await prisma.oilResearchRunner.findUniqueOrThrow({ where: { id: "runner" } })).toMatchObject({ pausedReason: "provider", pausedUntil: at(15 * MIN), lastSeenAt: at(MIN) });
      } finally {
        await cleanUp();
      }
    });

    it("claims an attended row an enqueue holds locked once the lock clears, not a backfill row", async () => {
      try {
        await prisma.oilResearchRunner.create({ data: { id: "runner" } });
        await prisma.$transaction((tx) => enqueue(tx, backfill(ARGO), at(-HOUR)));
        await prisma.$transaction((tx) => enqueue(tx, quoteOpen(POLO), at(-MIN)));
        let releaseEnqueue!: () => void;
        const enqueueHolds = new Promise<void>((done) => (releaseEnqueue = done));
        let locked!: () => void;
        const rowLocked = new Promise<void>((done) => (locked = done));
        // A repeat quote-open: its ON CONFLICT … DO UPDATE … WHERE writes nothing, but row-locks.
        const repeat = prisma.$transaction(
          async (tx) => {
            expect(await enqueue(tx, quoteOpen(POLO))).toMatchObject({ status: "unchanged" });
            locked();
            await enqueueHolds;
          },
          { timeout: 60_000, maxWait: 30_000 },
        );
        let claimed: ClaimResult | undefined;
        let claiming: Promise<unknown> | undefined;
        try {
          await rowLocked;
          claiming = prisma.$transaction(async (tx) => {
            claimed = await claim(tx);
          }, { timeout: 60_000, maxWait: 30_000 });
          await new Promise((done) => setTimeout(done, 500));
        } finally {
          releaseEnqueue();
          await repeat;
          await claiming;
        }
        expect(claimed).toMatchObject({ type: "research", identityKey: keyOf(POLO), priority: 0 });
        expect(await research(prisma, ARGO)).toMatchObject({ state: "queued" });
      } finally {
        await prisma.vehicle.deleteMany({});
        await prisma.customer.deleteMany({});
        await cleanUp();
      }
    });

    it("leaves Tecfil to the pending cycle when a verified record starts one", inTx(async (tx) => {
      await enqueue(tx, quoteOpen(GOL));
      const claimed = asResearch(await claim(tx));
      await enqueue(tx, refetch(GOL), at(MIN));
      const recorded = await asQuotes(tx, (q) => recordResearch(q, claimed, { outcome: "verified", cacheRow: cacheRow(GOL), sourcesReadAt: NOW }, { now: at(2 * MIN), leaseMs: LEASE_MS }));
      expect(recorded).toMatchObject({ status: "recorded", state: "queued", tecfil: null });
      expect(await research(tx, GOL)).toMatchObject({ state: "queued", kind: "refetch", tecfilState: null, tecfilAttempts: 0, tecfilLeaseUntil: null });
      expect(await tx.motulCompatibility.count()).toBe(1);
    }));

    it("starts a pending refetch's cycle on a release with requested_at anew and its estimate", inTx(async (tx) => {
      await enqueue(tx, backfill(GOL), at(-HOUR));
      const claimed = asResearch(await claim(tx, at(-10 * MIN)));
      await enqueue(tx, refetch(GOL), at(-2 * MIN));
      expect(await asQuotes(tx, (q) => releaseResearch(q, claimed, { now: NOW }))).toBe(true);
      const row = await research(tx, GOL);
      expect(row).toMatchObject({ state: "queued", kind: "refetch", trigger: "refetch", priority: 0, attempts: 0, cycleQueuedAt: NOW, requestedAt: at(-2 * MIN), pendingKind: null });
      // (now − requested_at) = 2 min, plus the defaults' 1–5.
      expect(expectedMinutes({ minS: row.expectedMinS!, maxS: row.expectedMaxS! })).toEqual({ min: 3, max: 7 });
    }));

    it("starts a pending refetch's cycle on an expired lease with requested_at anew and its estimate", inTx(async (tx) => {
      await enqueue(tx, backfill(GOL), at(-HOUR));
      asResearch(await claim(tx, at(-LEASE_MS - MIN)));
      await enqueue(tx, refetch(GOL), at(-2 * MIN));
      await asQuotes(tx, (q) => sweepExpiredLeases(q, NOW));
      const row = await research(tx, GOL);
      expect(row).toMatchObject({ state: "queued", kind: "refetch", priority: 0, attempts: 0, requestedAt: at(-2 * MIN), cycleQueuedAt: NOW });
      expect(expectedMinutes({ minS: row.expectedMinS!, maxS: row.expectedMaxS! })).toEqual({ min: 3, max: 7 });
    }));

    it("keeps a pending manual upgrade when the sweep finds the cycle out of attempts", inTx(async (tx) => {
      await enqueue(tx, quoteOpen(GOL), at(-HOUR));
      await tx.oilResearch.update({ where: { identityKey: keyOf(GOL) }, data: { attempts: 2 } });
      asResearch(await claim(tx, at(-LEASE_MS - MIN)));
      await enqueue(tx, upgrade(GOL), at(-2 * MIN));
      await asQuotes(tx, (q) => sweepExpiredLeases(q, NOW));
      expect(await research(tx, GOL)).toMatchObject({
        state: "queued",
        kind: "manual_resolve",
        trigger: "manual_upgrade",
        priority: 1,
        attempts: 0,
        requestedAt: at(-2 * MIN),
        outcome: "failed",
        pendingKind: null,
      });
    }));

    it.each([
      ["a retry", { outcome: "transient", sourcesReadAt: at(-MIN) }],
      ["a failure", { outcome: "failed" }],
      ["a wait", { outcome: "waiting_manual", waitUntil: at(30 * MIN), sourcesReadAt: at(-MIN) }],
    ] as const)("does not move sources_read_at on %s", async (_label, record) =>
      withTestTransaction(prisma, async (tx) => {
        await enqueue(tx, quoteOpen(GOL));
        await tx.oilResearch.update({ where: { identityKey: keyOf(GOL) }, data: { sourcesReadAt: at(-HOUR) } });
        const claimed = asResearch(await claim(tx));
        await asQuotes(tx, (q) => recordResearch(q, claimed, record, { now: at(MIN), leaseMs: LEASE_MS }));
        expect((await research(tx, GOL)).sourcesReadAt).toEqual(at(-HOUR));
      }));

    it("moves sources_read_at when the last attempt's fallback becomes the outcome", inTx(async (tx) => {
      await enqueue(tx, quoteOpen(GOL));
      await tx.oilResearch.update({ where: { identityKey: keyOf(GOL) }, data: { attempts: 2, sourcesReadAt: at(-HOUR) } });
      const last = asResearch(await claim(tx));
      await asQuotes(tx, (q) =>
        recordResearch(q, last, { outcome: "transient", fallback: { outcome: "conflicting_sources", payload: { conflicts: [] } }, sourcesReadAt: at(-MIN) }, { now: at(MIN), leaseMs: LEASE_MS }),
      );
      expect(await research(tx, GOL)).toMatchObject({ state: "conflicting_sources", sourcesReadAt: at(-MIN) });
    }));

    it("keeps wait_started_at through a retried re-resolve, for the manual path's run row", inTx(async (tx) => {
      await enqueue(tx, quoteOpen(GOL));
      const stage1 = asResearch(await claim(tx));
      await asQuotes(tx, (q) => recordResearch(q, stage1, { outcome: "waiting_manual", waitUntil: at(30 * MIN) }, { now: at(MIN), leaseMs: LEASE_MS }));
      await asQuotes(tx, (q) => endManualWait(q, stage1.id, at(10 * MIN)));
      const first = asResearch(await claim(tx, at(11 * MIN)));
      expect(first.waitStartedAt).toEqual(at(MIN));
      await asQuotes(tx, (q) => recordResearch(q, first, { outcome: "transient" }, { now: at(12 * MIN), leaseMs: LEASE_MS }));
      const retry = asResearch(await claim(tx, at(20 * MIN)));
      expect(retry).toMatchObject({ kind: "manual_resolve", path: "manual", waitStartedAt: at(MIN) });
      expect(await tx.oilResearchRun.findUniqueOrThrow({ where: { id: retry.runId } })).toMatchObject({ path: "manual", waitStartedAt: at(MIN) });
    }));
  });

  describe("the daily budget", () => {
    it("counts a run at 02:59:59Z toward the previous local day and one at 03:00:00Z toward the new one", inTx(async (tx) => {
      await runRow(tx, { startedAt: new Date("2026-09-26T02:59:59.000Z"), costUsd: 0.1 });
      await runRow(tx, { startedAt: new Date("2026-09-26T03:00:00.000Z"), costUsd: 0.2 });
      const spend = (now: Date) => asQuotes(tx, (q) => daySpendUsd(q, now));
      expect(await spend(new Date("2026-09-26T02:59:59.500Z"))).toBeCloseTo(0.1, 6);
      expect(await spend(new Date("2026-09-26T15:00:00.000Z"))).toBeCloseTo(0.2, 6);
    }));

    it("counts unknown-usage estimates, reading runs, attended runs, and released and lost runs' spend", inTx(async (tx) => {
      const meter = createUsageMeter();
      meter.onCall({ model: "gpt-6.1-sol", usage: null, timedOut: true, accepted: true });
      const unknown = meter.snapshot().costUsd;
      expect(unknown).toBeGreaterThan(0);
      await runRow(tx, { startedAt: at(-HOUR), costUsd: unknown });
      await runRow(tx, { startedAt: at(-HOUR), path: "reading", kind: "manual_reading", outcome: "verified", costUsd: 0.01 });
      await runRow(tx, { startedAt: at(-HOUR), trigger: "quote_open", costUsd: 0.02 });
      await runRow(tx, { startedAt: at(-HOUR), outcome: "released", costUsd: 0.03 });
      await runRow(tx, { startedAt: at(-HOUR), outcome: "lost", costUsd: 0.04 });
      expect(await asQuotes(tx, (q) => daySpendUsd(q, NOW))).toBeCloseTo(unknown + 0.1, 6);
    }));

    // switch-oil-research-to-openai task 4.4: the recorded cost of a run written while GLM did the
    // research counts toward the day exactly like any other, and its row (the `glm:` model key, the
    // NULL of a row older than the column, the `glm_calls` count and the per-model token map) reads.
    it("counts the recorded cost of GLM-era runs toward the day, whatever model key they carry", inTx(async (tx) => {
      await runRow(tx, { startedAt: at(-HOUR), costUsd: 0.3, researchModel: "glm:glm-5.3-flash:high" });
      await runRow(tx, { startedAt: at(-HOUR), costUsd: 0.2, researchModel: null });
      await runRow(tx, { startedAt: at(-HOUR), costUsd: 0.1, researchModel: "openai:gpt-6.1-sol:medium" });
      expect(await asQuotes(tx, (q) => daySpendUsd(q, NOW))).toBeCloseTo(0.6, 6);
      const stored = await tx.oilResearchRun.findMany({ where: { researchModel: "glm:glm-5.3-flash:high" } });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ glmCalls: 0 });
    }));

    it("at the budget, holds a priority-2 research and still claims a priority-2 Tecfil-only, and priority 0 and 1", inTx(async (tx) => {
      await runRow(tx, { startedAt: at(-2 * HOUR), trigger: "quote_open", costUsd: 1 });
      await enqueue(tx, backfill(GOL));
      expect((await claim(tx)).type).toBe("idle");

      await adoptableCache(tx, POLO, at(-HOUR));
      await enqueue(tx, backfill(POLO));
      const tecfil = asTecfil(await claim(tx));
      expect(tecfil.priority).toBe(2);
      await asQuotes(tx, (q) => recordTecfil(q, tecfil, { state: "ok", row: tecfilRow(POLO) }, { now: NOW }));

      await enqueue(tx, registration(ARGO));
      const attended = asResearch(await claim(tx, at(MIN)));
      expect(attended.identityKey).toBe(keyOf(ARGO));
      await tx.oilResearch.update({ where: { id: attended.id }, data: { state: "no_spec" } });
      await enqueue(tx, quoteOpen(ONIX));
      expect(asResearch(await claim(tx, at(MIN))).identityKey).toBe(keyOf(ONIX));
    }));

    it("stops the backfill on attended spend alone", inTx(async (tx) => {
      await runRow(tx, { startedAt: at(-HOUR), trigger: "quote_open", costUsd: 0.9 });
      await runRow(tx, { startedAt: at(-HOUR), trigger: "registration", costUsd: 0.1 });
      await enqueue(tx, backfill(GOL));
      expect((await claim(tx)).type).toBe("idle");
      expect((await claim(tx, new Date("2026-09-27T03:00:00.000Z"))).type).toBe("research");
    }));

    it("records the spend of a priority-0 run claimed past the budget, adding to the day's total", inTx(async (tx) => {
      await runRow(tx, { startedAt: at(-HOUR), costUsd: 1 });
      await enqueue(tx, quoteOpen(GOL));
      const claimed = asResearch(await claim(tx));
      await asQuotes(tx, (q) => recordResearch(q, claimed, { outcome: "no_spec", searched: true, sourcesReadAt: NOW }, { now: at(MIN), leaseMs: LEASE_MS, meter: meterWorth(0.25) }));
      expect(await asQuotes(tx, (q) => daySpendUsd(q, at(MIN)))).toBeCloseTo(1.25, 6);
    }));

    it("with a budget of 0, claims no priority-2 research, still claims priority 0 and 1, and does not read as stopped", inTx(async (tx) => {
      await enqueue(tx, backfill(GOL));
      expect((await claim(tx, NOW, { budgetUsd: 0 })).type).toBe("idle");
      await enqueue(tx, registration(POLO));
      expect(asResearch(await claim(tx, NOW, { budgetUsd: 0 })).identityKey).toBe(keyOf(POLO));

      const status = await asQuotes(tx, (q) => writeRunnerHeartbeat(q, { now: NOW, keySet: true, searchAvailable: true, budgetUsd: 0 }));
      expect(status).toMatchObject({ pausedReason: "budget", pausedUntil: new Date("2026-09-27T03:00:00.000Z") });
      expect(researchStopped(await asQuotes(tx, (q) => readRunnerStatus(q)), false, at(MIN))).toBe(false);
    }));
  });

  describe("the stored estimate", () => {
    it("reads the search path's P25–P90 over at least twenty answered runs, excluding outages, failures and sub-second runs", inTx(async (tx) => {
      const durations = [60, 60, 60, 60, 60, 70, ...Array<number>(12).fill(100), 250, 300, 300];
      for (const [i, seconds] of durations.entries()) await runRow(tx, { startedAt: at(-HOUR - i * MIN), ms: seconds * 1000 });
      for (const outcome of ["released", "lost", "unavailable", "failed"]) await runRow(tx, { startedAt: at(-HOUR), ms: 3_000_000, outcome });
      await runRow(tx, { startedAt: at(-HOUR), ms: 500 });
      await runRow(tx, { startedAt: at(-HOUR), ms: 3_000_000, path: "manual", kind: "manual_resolve", trigger: "manual_upgrade" });
      const timings = await asQuotes(tx, (q) => loadPathTimings(q, "search", NOW));
      expect(timings).toEqual({ range: { lowerS: 70, upperS: 250 }, p50S: 100 });
    }));

    it("does not let GLM-era runs set the estimate after the switch (switch-oil-research-to-openai D7)", inTx(async (tx) => {
      // 150 GLM runs of 400 s — 30 of them written before the column (NULL) — and 5 on GPT-6.1 Sol.
      for (let i = 0; i < 120; i += 1) await runRow(tx, { startedAt: at(-HOUR - i * 1000), ms: 400_000, researchModel: "glm:glm-5.3-flash:high" });
      for (let i = 0; i < 30; i += 1) await runRow(tx, { startedAt: at(-2 * HOUR - i * 1000), ms: 400_000, researchModel: null });
      for (let i = 0; i < 5; i += 1) await runRow(tx, { startedAt: at(-HOUR - i * 1000), ms: 130_000, researchModel: "openai:gpt-6.1-sol:medium" });
      expect(await asQuotes(tx, (q) => loadPathTimings(q, "search", NOW, "openai:gpt-6.1-sol:medium"))).toEqual({ range: { lowerS: 60, upperS: 300 }, p50S: 60 });
      // The GLM sample, the NULL rows included, is still the GLM model's.
      expect(await asQuotes(tx, (q) => loadPathTimings(q, "search", NOW, "glm:glm-5.3-flash:high"))).toEqual({ range: { lowerS: 400, upperS: 400 }, p50S: 400 });
    }));

    it("starts a new sample when the effort changes (switch-oil-research-to-openai D7)", inTx(async (tx) => {
      for (let i = 0; i < 40; i += 1) await runRow(tx, { startedAt: at(-HOUR - i * 1000), ms: 130_000, researchModel: "openai:gpt-6.1-sol:medium" });
      expect(await asQuotes(tx, (q) => loadPathTimings(q, "search", NOW, "openai:gpt-6.1-sol:high"))).toEqual({ range: { lowerS: 60, upperS: 300 }, p50S: 60 });
      expect(await asQuotes(tx, (q) => loadPathTimings(q, "search", NOW, "openai:gpt-6.1-sol:medium"))).toEqual({ range: { lowerS: 130, upperS: 130 }, p50S: 130 });
      expect(await tx.oilResearchRun.count({ where: { researchModel: "openai:gpt-6.1-sol:medium" } })).toBe(40);
    }));

    it("gives the defaults under twenty runs", inTx(async (tx) => {
      for (let i = 0; i < 19; i += 1) await runRow(tx, { startedAt: at(-HOUR), ms: 400_000 });
      expect(await asQuotes(tx, (q) => loadPathTimings(q, "search", NOW))).toEqual({ range: { lowerS: 60, upperS: 300 }, p50S: 60 });
    }));

    it("holds the 200-run and 30-day window", inTx(async (tx) => {
      // 200 recent runs of 100 s, then older ones that would move every percentile.
      for (let i = 0; i < 200; i += 1) await runRow(tx, { startedAt: at(-HOUR - i * 1000), ms: 100_000 });
      for (let i = 0; i < 30; i += 1) await runRow(tx, { startedAt: at(-2 * 24 * HOUR - i * 1000), ms: 900_000 });
      for (let i = 0; i < 30; i += 1) await runRow(tx, { startedAt: at(-31 * 24 * HOUR), ms: 900_000 });
      expect(await asQuotes(tx, (q) => loadPathTimings(q, "search", NOW))).toEqual({ range: { lowerS: 100, upperS: 100 }, p50S: 100 });
    }));

    it("measures the manual path as the wait plus the re-resolve's run, not the time before its claim", inTx(async (tx) => {
      // Wait 200 s (wait start → re-resolve queued), then 5 min in a queue, then a 40 s run: 240 s.
      for (let i = 0; i < 20; i += 1) {
        const waitStartedAt = at(-3 * HOUR - i * MIN);
        const queuedAt = new Date(waitStartedAt.getTime() + 200_000);
        await runRow(tx, { path: "manual", kind: "manual_resolve", trigger: "wait_ended", waitStartedAt, queuedAt, startedAt: new Date(queuedAt.getTime() + 5 * MIN), ms: 40_000 });
      }
      await runRow(tx, { path: "manual", kind: "manual_resolve", trigger: "manual_upgrade", waitStartedAt: at(-HOUR), queuedAt: at(-HOUR), startedAt: at(-HOUR), ms: 9_000_000 });
      await runRow(tx, { path: "search", kind: "refetch", trigger: "refetch", startedAt: at(-HOUR), ms: 9_000_000 });
      const manual = await asQuotes(tx, (q) => loadPathTimings(q, "manual", NOW));
      expect(manual.range).toEqual({ lowerS: 240, upperS: 240 });
    }));

    it("keeps 5–9 for a row claimed 4 min after it was requested when the queue was right, and never changes it on a read", inTx(async (tx) => {
      // Four ahead at the default P50 of 1 min: 4 min of queue on the defaults' 1–5.
      for (const [i, identity] of [POLO, ARGO, ONIX, { ...POLO, version: "1.6" }].entries()) await enqueue(tx, quoteOpen(identity), at(-(i + 1) * MIN));
      await enqueue(tx, quoteOpen(GOL));
      const queued = await research(tx, GOL);
      expect(expectedMinutes({ minS: queued.expectedMinS!, maxS: queued.expectedMaxS! })).toEqual({ min: 5, max: 9 });
      expect(await enqueue(tx, quoteOpen(GOL), at(3_000))).toMatchObject({ status: "unchanged" });
      expect(await research(tx, GOL)).toEqual(queued);

      await tx.oilResearch.updateMany({ where: { identityKey: { not: keyOf(GOL) } }, data: { state: "no_spec" } });
      asResearch(await claim(tx, at(4 * MIN)));
      const claimed = await research(tx, GOL);
      expect(expectedMinutes({ minS: claimed.expectedMinS!, maxS: claimed.expectedMaxS! })).toEqual({ min: 5, max: 9 });
    }));

    it("gives 2–7 on entering the wait one minute after the request, on the manual defaults", inTx(async (tx) => {
      await enqueue(tx, quoteOpen(GOL));
      const claimed = asResearch(await claim(tx));
      await asQuotes(tx, (q) => recordResearch(q, claimed, { outcome: "waiting_manual", waitUntil: at(31 * MIN), sourcesReadAt: NOW }, { now: at(MIN), leaseMs: LEASE_MS }));
      const row = await research(tx, GOL);
      expect(row).toMatchObject({ state: "waiting_manual", waitStartedAt: at(MIN), manualWaitUntil: at(31 * MIN) });
      expect(expectedMinutes({ minS: row.expectedMinS!, maxS: row.expectedMaxS! })).toEqual({ min: 2, max: 7 });
    }));
  });
});
