/**
 * Test design (testing-strategy) — the research runner, on a scratch database
 *
 * SUT: `quotes/run-oil-research`'s tick (`runOilResearchTick`, through the slice's entry point):
 *   the heartbeat, the key and pause gates, the claim, the run over ONE injected fake ports object,
 *   D10's recording, the provider pause and the outage breaker, the Tecfil step (D12), and the
 *   release on stop (D19). Every store call runs under the `quotes` role on the real schema.
 *
 * Why a scratch database: a claim takes ANY due row under the runner-row lock, so rows another
 *   suite left in the shared database would be claimed here. Each case runs in the rollback
 *   harness on it (module role: `quotes`).
 *
 * Oracle: background-oil-research D8–D10, D12, D14, D19 and tasks 3.3, 3.4 and 3.6's Verify lists;
 *   `oil-research`'s scenarios. The fakes never reach a provider; they record whether a `db.tx`
 *   was open when called (never), and feed the run's meter as the real ports would, so the run
 *   row's cost is checked against a meter fed the same calls at the list prices.
 *
 * Fixed clock: the runner, the claim and every write take `now`; nothing depends on the wall
 *   clock except the run ceiling's timer, which one case sets to 50 ms on purpose.
 */
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { shouldRunLiveTests, type DbClient } from "@select-lub/core/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createUsageMeter } from "../src/modules/quotes/internal/model-calls/meter.js";
import { ESCALATION_FAILED, EXTRACTION_FAILED } from "../src/modules/quotes/internal/pipeline/oil-spec.js";
import { daySpendUsd } from "../src/modules/quotes/internal/research/budget.js";
import { identityKey } from "../src/modules/quotes/internal/research/identity-key.js";
import { claimNextResearch, enqueueResearch, recordResearch, type EnqueueRequest, type ResearchClaim } from "../src/modules/quotes/internal/research/research-store.js";
import { readRunnerStatus } from "../src/modules/quotes/internal/research/runner-row.js";
import { runCeilingMs, researchLeaseMs } from "../src/modules/quotes/internal/research/settings.js";
import { createWebSearchRetriever } from "../src/modules/quotes/internal/retrieval/web-search.js";
import { createOutageBreaker, runOilResearchTick, type RunTickResult } from "../src/modules/quotes/run-oil-research/index.js";
import { withConnectRetry, withTestTransaction } from "../src/testing/index.js";
import { at, fakePorts, modelCall, MIN, NOW, page, SETTINGS, TECFIL_OK, trackedDb, VERIFIED_SPEC, type FakeScript } from "./oil-research-harness.js";
import { createScratchDatabase, type ScratchDatabase } from "./scratch-database.js";

const hasDatabase = shouldRunLiveTests();
const repoRoot = resolve(import.meta.dirname, "../../..");
const SCRATCH_SETUP_TIMEOUT_MS = 180_000;

const GOL = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0 FLEX 12V 4P" };
const ARGO = { make: "Fiat", year: 2022, model: "Argo", version: "1.3 Drive" };
const ONIX = { make: "Chevrolet", year: 2019, model: "Onix", version: "1.4 LT" };
const KWID = { make: "Renault", year: 2020, model: "Kwid", version: "1.0 Zen" };
type Identity = typeof GOL;

const quoteOpen = (identity: Identity): EnqueueRequest => ({ identity, kind: "full", priority: 0, trigger: "quote_open" });
const research = (tx: DbClient, identity: Identity) => tx.oilResearch.findUniqueOrThrow({ where: { identityKey: identityKey(identity)! } });
const runs = (tx: DbClient, identity: Identity) => tx.oilResearchRun.findMany({ where: { identityKey: identityKey(identity)! }, orderBy: { startedAt: "asc" } });

describe.skipIf(!hasDatabase)("quotes/run-oil-research — live, on a scratch database", () => {
  let scratch: ScratchDatabase | undefined;
  let prisma!: PrismaClient;

  beforeAll(async () => {
    scratch = await createScratchDatabase(process.env.DATABASE_URL ?? "", "oil_research_runner", repoRoot);
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

  /** A runner over the fakes on this transaction; `tick` runs one tick at `now`. */
  function runner(tx: DbClient, script: FakeScript = {}, settings = SETTINGS, afterTx?: () => Promise<void>) {
    const db = trackedDb(tx, afterTx);
    const { ports, probe } = fakePorts(db, script);
    const breaker = createOutageBreaker(settings.outageBreaker);
    const tick = (now = NOW, stop = new AbortController().signal): Promise<RunTickResult> =>
      runOilResearchTick({ db, ports, settings, now: () => now, breaker }, stop);
    const enqueue = (request: EnqueueRequest, now = NOW) => db.tx("quotes", (q) => enqueueResearch(q, request, now));
    return { db, probe, tick, enqueue };
  }

  describe("the gates", () => {
    it("claims nothing without the key, and says it waits for it", inTx(async (tx) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const r = runner(tx, { keySet: false });
        await r.enqueue(quoteOpen(GOL));

        expect(await r.tick()).toEqual({ outcome: "no_key" });
        expect(await research(tx, GOL)).toMatchObject({ state: "queued", attempts: 0 });
        expect(r.probe.calls).toEqual([]);
        expect(warn).toHaveBeenCalledWith("oil-research", expect.stringContaining("no_key"));
        expect(await readRunnerStatus(tx)).toMatchObject({ keySet: false, pausedReason: "no_key", lastSeenAt: NOW });
      } finally {
        warn.mockRestore();
      }
    }));

    // Orchestrator ruling, review of #188: the heartbeat records whether a web search could run.
    it("records on its heartbeat whether it can web-search", inTx(async (tx) => {
      await runner(tx, { searchAvailable: false }).tick();
      expect(await readRunnerStatus(tx)).toMatchObject({ searchAvailable: false, lastSeenAt: NOW });
      await runner(tx, { searchAvailable: true }).tick(at(MIN));
      expect(await readRunnerStatus(tx)).toMatchObject({ searchAvailable: true, lastSeenAt: at(MIN) });
    }));

    it("claims nothing while research is paused for the provider", inTx(async (tx) => {
      const r = runner(tx);
      await tx.oilResearchRunner.create({ data: { id: "runner", pausedReason: "provider", pausedUntil: at(10 * MIN) } });
      await r.enqueue(quoteOpen(GOL));

      expect(await r.tick()).toEqual({ outcome: "paused" });
      expect(await research(tx, GOL)).toMatchObject({ state: "queued", attempts: 0 });
      // The pause ends at its time: the same row is then claimed.
      expect((await r.tick(at(11 * MIN))).outcome).toBe("research");
    }));
  });

  describe("a verified run", () => {
    it("records the spec, its cache row and Tecfil, with the run's stages, calls, tokens, efforts and cost", inTx(async (tx) => {
      // Two tier-3 pages that disagree on the liters; escalation settles it within their values.
      const script: FakeScript = {
        retrieve: async (ctx) => {
          await ctx.step("motul", async () => undefined);
          return ctx.step("webSearch", async () => {
            ctx.meter.onToolCall({ answered: true });
            ctx.meter.onToolCall({ answered: true });
            ctx.meter.onCall(modelCall(300));
            ctx.meter.onCall(modelCall(0, { usage: null, timedOut: true }));
            return { status: "found", sources: [page("a.com.br", "a"), page("b.com.br", "b")] };
          });
        },
        extract: async (source) => ({ ...VERIFIED_SPEC, fillLiters: source.publisher === "a.com.br" ? 4 : 4.2 }),
        escalate: async () => VERIFIED_SPEC,
        tecfil: async (ctx) => {
          ctx.meter.onCall({ model: "gpt-5.6-luna", provider: "openai", usage: { input: 500, cachedInput: 0, reasoning: 0, output: 20 }, timedOut: false, accepted: true, picker: true });
          return TECFIL_OK;
        },
      };
      const r = runner(tx, script);
      await r.enqueue(quoteOpen(GOL));

      const result = await r.tick();

      expect(result).toMatchObject({ outcome: "research", run: { outcome: "verified", state: "verified", tecfil: "ok" } });
      expect(await research(tx, GOL)).toMatchObject({ state: "verified", outcome: "verified", attempts: 1, tecfilState: "ok", tecfilAttempts: 0 });
      const cache = await tx.motulCompatibility.findMany({ where: { model: "Gol" } });
      expect(cache).toHaveLength(1);
      expect(cache[0]).toMatchObject({ viscosities: ["5W-40"], sourcePublisher: "a.com.br" });
      expect(Number(cache[0]!.fillLiters)).toBe(4);
      expect(await tx.tecfilCompatibility.count({ where: { model: "Gol" } })).toBe(1);

      const [row] = await runs(tx, GOL);
      expect(row).toMatchObject({ outcome: "verified", path: "search", kind: "full", trigger: "quote_open", glmCalls: 5, searchCalls: 2, timedOutCalls: 1, pickerCalls: 1, incomplete: false });
      expect(Object.keys(row!.stageMs as object).sort()).toEqual(["escalation", "extraction", "motul", "passage", "tecfil", "webSearch"]);
      expect(row!.efforts).toEqual([{ model: "gpt-6.1-sol", effort: "medium" }]);
      expect((row!.tokens as Record<string, { output: number }>)["openai:gpt-6.1-sol"]).toMatchObject({ calls: 5, output: 300 + 500 + 500 + 700 });

      // The cost the fakes fed, priced at the list: the picker's apart, outside the cap.
      const expected = createUsageMeter();
      expected.onToolCall({ answered: true });
      expected.onToolCall({ answered: true });
      for (const output of [300, 500, 500, 700]) expected.onCall(modelCall(output));
      expected.onCall(modelCall(0, { usage: null, timedOut: true }));
      expect(row!.costUsd.toNumber()).toBeCloseTo(expected.snapshot().costUsd, 6);
      expect(row!.pickerCostUsd.toNumber()).toBeGreaterThan(0);
      expect(await daySpendUsd(tx, NOW)).toBeCloseTo(expected.snapshot().costUsd, 6);

      expect(r.probe.txOpenDuringCall).toBe(false);
      expect(r.probe.calls).toEqual(expect.arrayContaining(["retrieve", "extract", "passage", "escalate", "tecfil"]));
    }));

    it("consults Tecfil for a verified identity whatever the catalog holds (it holds no oil at all here)", inTx(async (tx) => {
      const r = runner(tx);
      await r.enqueue(quoteOpen(ARGO));
      await r.tick();

      expect(await tx.catalogItem.count()).toBe(0);
      expect(await research(tx, ARGO)).toMatchObject({ state: "verified", tecfilState: "ok" });
      expect(await tx.tecfilCompatibility.count({ where: { model: "Argo" } })).toBe(1);
    }));
  });

  describe("outcomes and outages (D10)", () => {
    it("retries a page that answered 503, rather than recording no source", inTx(async (tx) => {
      const r = runner(tx, { retrieve: async () => ({ status: "none", incomplete: true }) });
      await r.enqueue(quoteOpen(GOL));

      expect(await r.tick()).toMatchObject({ run: { outcome: "unavailable", state: "queued" } });
      expect(await research(tx, GOL)).toMatchObject({ state: "queued", attempts: 1, dueAt: at(5 * MIN), outcome: null });
    }));

    it("retries a timed-out extraction, then records failed on the last attempt", inTx(async (tx) => {
      const r = runner(tx, { retrieve: async () => ({ status: "found", sources: [page("a", "x")] }), extract: async () => EXTRACTION_FAILED });
      await r.enqueue(quoteOpen(GOL));

      await r.tick();
      expect(await research(tx, GOL)).toMatchObject({ state: "queued", dueAt: at(5 * MIN) });
      await r.tick(at(5 * MIN));
      expect(await research(tx, GOL)).toMatchObject({ state: "queued", dueAt: at(20 * MIN) });
      await r.tick(at(20 * MIN));
      expect(await research(tx, GOL)).toMatchObject({ state: "failed", outcome: "failed", attempts: 3 });
    }));

    it("keeps a clarification read on the last attempt, and records a no-source miss as failed", inTx(async (tx) => {
      const clarify = runner(tx, {
        retrieve: async () => ({ status: "found", sources: [page("b", "y"), page("a", "x")] }),
        extract: async (source) => (source.publisher === "a" ? { ...VERIFIED_SPEC, engineCoverage: "several", enginesNamed: ["1.0", "1.6"] } : EXTRACTION_FAILED),
      });
      await clarify.enqueue(quoteOpen(GOL));
      for (const when of [NOW, at(5 * MIN), at(20 * MIN)]) await clarify.tick(when);
      expect(await research(tx, GOL)).toMatchObject({ state: "needs_clarification", outcomePayload: { coverage: "several", options: ["1.0", "1.6"] } });
    }));

    it("records a complete no-source miss the web could not search as not searched", inTx(async (tx) => {
      const r = runner(tx, { retrieve: async () => ({ status: "none", notSearched: true }) }, { ...SETTINGS, manualIngestion: false });
      await r.enqueue(quoteOpen(GOL));
      await r.tick();

      expect(await research(tx, GOL)).toMatchObject({ state: "no_spec", searched: false });
    }));

    it("does not wait for a manual when stage 1 could not search, so the next quote-open reopens it at once", inTx(async (tx) => {
      const r = runner(tx, {
        retrieve: async () => ({
          status: "none",
          notSearched: true,
          manualCandidates: [{ url: "https://www.vw.com.br/manuais/gol-2021.pdf", publisher: "vw.com.br", classification: "manufacturer_manual", tier: 1, label: "Manual Gol 2021" }],
        }),
      });
      await r.enqueue(quoteOpen(GOL));

      expect(await r.tick()).toMatchObject({ run: { outcome: "no_spec" } });
      expect(await research(tx, GOL)).toMatchObject({ state: "no_spec", searched: false });
      expect(await tx.oilManualReading.count()).toBe(0);
      // D10: not searched is re-run by the next quote-open, however soon.
      await r.enqueue(quoteOpen(GOL), at(MIN));
      expect(await research(tx, GOL)).toMatchObject({ state: "queued", attempts: 0 });
    }));

    it("treats a Motul outage with no other source as transient", inTx(async (tx) => {
      const r = runner(tx, { retrieve: async () => ({ status: "unavailable" }) });
      await r.enqueue(quoteOpen(GOL));

      expect(await r.tick()).toMatchObject({ run: { outcome: "unavailable" } });
      expect(await research(tx, GOL)).toMatchObject({ state: "queued", attempts: 1 });
    }));

    it("retries a failed escalation, and records a declined one as a conflict", inTx(async (tx) => {
      const two = async () => ({ status: "found" as const, sources: [page("a", "a"), page("b", "b")] });
      const extract = async (source: { publisher: string }) => ({ ...VERIFIED_SPEC, fillLiters: source.publisher === "a" ? 4 : 4.5 });
      const failed = runner(tx, { retrieve: two, extract, escalate: async () => ESCALATION_FAILED });
      await failed.enqueue(quoteOpen(GOL));
      await failed.tick();
      expect(await research(tx, GOL)).toMatchObject({ state: "queued", attempts: 1 });

      const declined = runner(tx, { retrieve: two, extract, escalate: async () => null });
      await declined.enqueue(quoteOpen(ARGO));
      await declined.tick();
      expect(await research(tx, ARGO)).toMatchObject({ state: "conflicting_sources" });
    }));

    it("treats a run past its ceiling as transient, its attempt counted and its spend recorded", inTx(async (tx) => {
      const r = runner(
        tx,
        {
          retrieve: (ctx) =>
            ctx.step("webSearch", async () => {
              ctx.meter.onToolCall({ answered: true });
              await new Promise((done) => ctx.signal.addEventListener("abort", done, { once: true }));
              return { status: "none" };
            }),
        },
        { ...SETTINGS, runTimeoutMs: 50 },
      );
      await r.enqueue(quoteOpen(GOL));

      expect(await r.tick()).toMatchObject({ run: { outcome: "unavailable" } });
      expect(await research(tx, GOL)).toMatchObject({ state: "queued", attempts: 1, dueAt: at(5 * MIN) });
      const [row] = await runs(tx, GOL);
      expect(row).toMatchObject({ outcome: "unavailable", searchCalls: 1 });
      expect(row!.costUsd.toNumber()).toBeCloseTo(0.01, 6);
    }));

    it("takes its run ceiling from the model's row: 45 min on gpt-6.1-sol at medium; its lease is 12 min; the setting overrides", () => {
      expect(runCeilingMs({ runTimeoutMs: null })).toBe(45 * MIN);
      expect(researchLeaseMs()).toBe(12 * MIN);
      expect(runCeilingMs({ runTimeoutMs: 5 * MIN })).toBe(5 * MIN);
    });
  });

  describe("provider refusals (D9)", () => {
    it("releases a run whose every call was refused with 401, pauses research, and books nothing", inTx(async (tx) => {
      const r = runner(tx, {
        retrieve: async (ctx) => {
          ctx.meter.onCall(modelCall(0, { usage: null, accepted: false }));
          ctx.report({ status: 401 });
          return { status: "unavailable" };
        },
      });
      // Requested one after the other: at one instant the claim order would fall to the random id.
      await r.enqueue(quoteOpen(GOL), at(-2_000));
      await r.enqueue(quoteOpen(ARGO), at(-1_000));

      expect(await r.tick()).toMatchObject({ run: { outcome: "released", paused: "provider" } });
      expect(await research(tx, GOL)).toMatchObject({ state: "queued", attempts: 0 });
      expect(await readRunnerStatus(tx)).toMatchObject({ pausedReason: "provider", pausedUntil: at(15 * MIN) });
      const [row] = await runs(tx, GOL);
      expect(row).toMatchObject({ outcome: "released" });
      expect(row!.costUsd.toNumber()).toBe(0);
      // Paused: the other identity keeps its attempts too.
      expect(await r.tick(at(MIN))).toEqual({ outcome: "paused" });
      expect(await research(tx, ARGO)).toMatchObject({ state: "queued", attempts: 0 });
    }));

    it("records a run whose one 429 a retry of the same call recovered, and does not count it as an outage", inTx(async (tx) => {
      // Each identity's search meets one 429, retried to success; the pipeline then ends complete.
      const r = runner(tx, {
        retrieve: async (ctx) => {
          ctx.report({ status: 429, code: "rate_limit_exceeded", retryAfterMs: 90_000, call: "search-1" });
          ctx.report({ status: 200, call: "search-1" });
          return { status: "found", sources: [page("a", "x")] };
        },
        extract: async () => ({ ...VERIFIED_SPEC, engineCoverage: "several", enginesNamed: ["1.0", "1.6"] }),
      });
      for (const [i, identity] of [GOL, ARGO, ONIX].entries()) await r.enqueue(quoteOpen(identity), at((i - 3) * 1_000));

      for (const identity of [GOL, ARGO, ONIX]) {
        expect(await r.tick()).toMatchObject({ run: { outcome: "needs_clarification" } });
        expect(await research(tx, identity)).toMatchObject({ state: "needs_clarification", attempts: 1 });
      }
      // Three in a row, and the breaker never counted one.
      expect((await readRunnerStatus(tx))?.pausedReason).toBeNull();
    }));

    it("releases a rate-limited run, due at its Retry-After", inTx(async (tx) => {
      const r = runner(tx, {
        retrieve: async (ctx) => {
          ctx.report({ status: 429, code: "rate_limit_exceeded", retryAfterMs: 90_000 });
          return { status: "unavailable" };
        },
      });
      await r.enqueue(quoteOpen(GOL));

      expect(await r.tick()).toMatchObject({ run: { outcome: "released" } });
      expect(await research(tx, GOL)).toMatchObject({ state: "queued", attempts: 0, dueAt: at(90_000) });
    }));

    it("treats a refused parameter on one identity as its outage, logged, without pausing the queue", inTx(async (tx) => {
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      try {
        let refuse = true;
        const r = runner(tx, {
          retrieve: async (ctx) => {
            if (refuse) {
              ctx.report({ status: 400, code: "unsupported_value", body: '{"error":{"code":"unsupported_value","message":"reasoning.effort is not supported"}}' });
              // Complete otherwise: only the refusal makes it an outage (a selector that degrades).
              return { status: "none" };
            }
            return { status: "found", sources: [page("a", "x")] };
          },
        });
        // Requested one after the other, so the claim order is theirs.
        await r.enqueue(quoteOpen(GOL), at(-2_000));
        await r.enqueue(quoteOpen(ARGO), at(-1_000));

        await r.tick();
        expect(await research(tx, GOL)).toMatchObject({ state: "queued", attempts: 1 });
        expect(info).toHaveBeenCalledWith("oil-research", expect.stringContaining("reasoning.effort is not supported"));
        refuse = false;
        await r.tick();
        expect(await research(tx, ARGO)).toMatchObject({ state: "verified" });
        expect((await readRunnerStatus(tx))?.pausedReason).toBeNull();
      } finally {
        info.mockRestore();
      }
    }));

    it.each([
      ["outages", { status: "unavailable" as const }, undefined],
      ["refused parameters", { status: "none" as const }, { status: 400, code: "unsupported_value" }],
    ])("pauses claiming after three consecutive %s on different identities", (_label, answer, refusal) =>
      withTestTransaction(prisma, async (tx) => {
        const r = runner(tx, {
          retrieve: async (ctx) => {
            if (refusal) ctx.report(refusal);
            return answer;
          },
        });
        for (const [i, identity] of [GOL, ARGO, ONIX, KWID].entries()) await r.enqueue(quoteOpen(identity), at((i - 4) * 1_000));

        const first = await r.tick();
        const second = await r.tick();
        expect([first, second].map((tick) => (tick.outcome === "research" ? tick.run.paused : "no run"))).toEqual([undefined, undefined]);
        expect(await r.tick()).toMatchObject({ run: { paused: "breaker" } });
        expect(await readRunnerStatus(tx)).toMatchObject({ pausedReason: "provider" });
        expect(await r.tick()).toEqual({ outcome: "paused" });
        expect(await research(tx, KWID)).toMatchObject({ state: "queued", attempts: 0 });
      }),
    );
  });

  describe("Tecfil (D12)", () => {
    it("keeps the spec verified when Tecfil is unavailable, and retries it on the backoff, then daily", inTx(async (tx) => {
      const r = runner(tx, { tecfil: async () => ({ result: { status: "unavailable" }, pickerFailed: false }) });
      await r.enqueue(quoteOpen(GOL));
      await r.tick();

      expect(await research(tx, GOL)).toMatchObject({ state: "verified", attempts: 1, tecfilState: "unavailable", tecfilAttempts: 1, tecfilDueAt: at(15 * MIN) });
      // Tecfil-only claims at each due time: 1 h, 6 h, then every 24 h; the spec's attempts never move.
      let when = at(15 * MIN);
      for (const backoff of [60 * MIN, 6 * 60 * MIN, 24 * 60 * MIN, 24 * 60 * MIN]) {
        expect(await r.tick(when)).toMatchObject({ outcome: "tecfil", tecfil: "unavailable" });
        const row = await research(tx, GOL);
        expect(row).toMatchObject({ state: "verified", attempts: 1 });
        expect(row.tecfilDueAt).toEqual(new Date(when.getTime() + backoff));
        when = row.tecfilDueAt!;
      }
    }));

    it("records a genuine no-match as unmatched with its field, and a picker failure as unavailable", inTx(async (tx) => {
      const genuine = runner(tx, { tecfil: async () => ({ result: { status: "unmatched", field: "engine" }, pickerFailed: false }) });
      await genuine.enqueue(quoteOpen(GOL));
      await genuine.tick();
      expect(await research(tx, GOL)).toMatchObject({ tecfilState: "unmatched", tecfilUnmatchedField: "engine" });

      const noKey = runner(tx, { tecfil: async () => ({ result: { status: "unmatched", field: "vehicle" }, pickerFailed: true }) });
      await noKey.enqueue(quoteOpen(ARGO));
      await noKey.tick();
      expect(await research(tx, ARGO)).toMatchObject({ tecfilState: "unavailable", tecfilUnmatchedField: null });
    }));

    it("writes no Tecfil row when the claim the record took over was lost, and leaves the spec verified", inTx(async (tx) => {
      const r = runner(tx, {
        tecfil: async () => {
          // Another claim of the row meanwhile.
          await tx.oilResearch.updateMany({ where: { identityKey: identityKey(GOL)! }, data: { currentRunId: "someone-else" } });
          return TECFIL_OK;
        },
      });
      await r.enqueue(quoteOpen(GOL));

      expect(await r.tick()).toMatchObject({ run: { outcome: "verified", tecfil: "lost" } });
      expect(await tx.tecfilCompatibility.count({ where: { model: "Gol" } })).toBe(0);
      expect(await research(tx, GOL)).toMatchObject({ state: "verified", attempts: 1 });
    }));

    it("completes a tecfil_only claim during the budget pause, paced at priority 2, its picker outside the day's sum", inTx(async (tx) => {
      const r = runner(
        tx,
        {
          tecfil: async (ctx) => {
            ctx.meter.onCall({ model: "gpt-5.6-luna", provider: "openai", usage: { input: 500, cachedInput: 0, reasoning: 0, output: 20 }, timedOut: false, accepted: true, picker: true });
            return TECFIL_OK;
          },
        },
        { ...SETTINGS, backfillPaceMs: MIN },
      );
      // An adopted identity with no Tecfil row: verified, Tecfil pending, backfill priority.
      await tx.motulCompatibility.create({
        data: { ...GOL, viscosities: ["5W-40"], viscosity: "5W-40", classification: "", sourcePublisher: "vw.com.br", sourceDocument: "Manual", sourcePage: "p. 3", consultedAt: at(-MIN) },
      });
      await r.enqueue({ identity: GOL, kind: "full", priority: 2, trigger: "backfill" });
      expect(await research(tx, GOL)).toMatchObject({ state: "verified", trigger: "adopted", tecfilState: "pending" });
      // The day's budget spent, and a run finished 30 s ago.
      await tx.oilResearchRun.create({ data: { id: "spent", identityKey: "x", kind: "full", trigger: "backfill", path: "search", startedAt: at(-2 * MIN), finishedAt: at(-30_000), costUsd: 1 } });

      expect(await r.tick()).toEqual({ outcome: "idle" });
      expect(await r.tick(at(30_000))).toMatchObject({ outcome: "tecfil", tecfil: "ok" });
      expect(await research(tx, GOL)).toMatchObject({ state: "verified", attempts: 0, tecfilState: "ok" });
      const [row] = await runs(tx, GOL);
      expect(row).toMatchObject({ path: "tecfil", kind: "tecfil_only", outcome: "ok", pickerCalls: 1 });
      expect(row!.costUsd.toNumber()).toBe(0);
      expect(await daySpendUsd(tx, at(30_000))).toBe(1);
    }));
  });

  describe("restart safety (D19)", () => {
    it("releases a run at once when the worker stops mid-search, with the spend so far, and writes nothing after", inTx(async (tx) => {
      let searching!: () => void;
      const started = new Promise<void>((done) => (searching = done));
      const r = runner(tx, {
        retrieve: (ctx) =>
          ctx.step("webSearch", async () => {
            ctx.meter.onToolCall({ answered: true });
            searching();
            // A search that answers only once it is aborted, and then with a page to read.
            await new Promise((done) => ctx.signal.addEventListener("abort", done, { once: true }));
            return { status: "found", sources: [page("a", "x")] };
          }),
      });
      await r.enqueue(quoteOpen(GOL));
      const stop = new AbortController();

      const tick = r.tick(NOW, stop.signal);
      await started;
      stop.abort();
      expect(await tick).toMatchObject({ run: { outcome: "released" } });

      expect(await research(tx, GOL)).toMatchObject({ state: "queued", attempts: 0 });
      const [row] = await runs(tx, GOL);
      expect(row).toMatchObject({ outcome: "released", searchCalls: 1 });
      expect(row!.costUsd.toNumber()).toBeCloseTo(0.01, 6);
      expect(await daySpendUsd(tx, NOW)).toBeCloseTo(0.01, 6);
      expect(await tx.motulCompatibility.count({ where: { model: "Gol" } })).toBe(0);
      expect(r.probe.calls).not.toContain("extract");
    }));

    it("releases within a second when stopped during the real web search over a transport that never answers", inTx(async (tx) => {
      const key = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key-never-sent";
      try {
        let requested!: () => void;
        const sent = new Promise<void>((done) => (requested = done));
        // The OpenAI socket: it never answers, and gives up only when aborted.
        const neverAnswers: typeof fetch = (_input, init) =>
          new Promise((_resolve, reject) => {
            requested();
            init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
          });
        const r = runner(tx, {
          retrieve: (ctx) =>
            ctx.step("webSearch", () =>
              createWebSearchRetriever({ httpFetch: neverAnswers, meter: ctx.meter, signal: ctx.signal, wait: async () => undefined, log: () => undefined })(GOL),
            ),
        });
        await r.enqueue(quoteOpen(GOL));
        const stop = new AbortController();

        const tick = r.tick(NOW, stop.signal);
        await sent;
        const stoppedAt = Date.now();
        stop.abort();
        expect(await tick).toMatchObject({ run: { outcome: "released" } });

        expect(Date.now() - stoppedAt).toBeLessThan(1_000);
        expect(await research(tx, GOL)).toMatchObject({ state: "queued", attempts: 0 });
      } finally {
        if (key === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = key;
      }
    }));

    it("releases the Tecfil claim a verified record took over when the worker stops right after that record", inTx(async (tx) => {
      const stop = new AbortController();
      // Stops the worker the moment the verified record has committed, before the Tecfil step.
      const afterTx = async () => {
        if (stop.signal.aborted) return;
        const row = await tx.oilResearch.findUnique({ where: { identityKey: identityKey(GOL)! } });
        if (row?.state === "verified") stop.abort();
      };
      const r = runner(tx, {}, SETTINGS, afterTx);
      await r.enqueue(quoteOpen(GOL));

      expect(await r.tick(NOW, stop.signal)).toMatchObject({ run: { outcome: "verified", tecfil: "released" } });
      expect(r.probe.calls).not.toContain("tecfil");
      expect(await research(tx, GOL)).toMatchObject({ state: "verified", attempts: 1, tecfilState: "pending", tecfilAttempts: 0, tecfilLeaseUntil: null });
    }));

    it("releases a Tecfil claim on stop: the spec stays verified, Tecfil pending with its attempt refunded", inTx(async (tx) => {
      const stop = new AbortController();
      const r = runner(tx, {
        tecfil: async (ctx) => {
          stop.abort();
          expect(ctx.signal.aborted).toBe(true);
          return TECFIL_OK;
        },
      });
      await r.enqueue(quoteOpen(GOL));

      expect(await r.tick(NOW, stop.signal)).toMatchObject({ run: { outcome: "verified", tecfil: "released" } });
      expect(await research(tx, GOL)).toMatchObject({ state: "verified", attempts: 1, tecfilState: "pending", tecfilAttempts: 0, tecfilDueAt: null });
      expect(await tx.tecfilCompatibility.count({ where: { model: "Gol" } })).toBe(0);
    }));

    it("reclaims a hard-killed run after its lease, and its lost claim adds no second cache row", inTx(async (tx) => {
      const r = runner(tx);
      await r.enqueue(quoteOpen(GOL));
      // A claim whose worker died before it ran: claimed, never recorded.
      const dead = await r.db.tx("quotes", async (q) => {
        return claimNextResearch(q, { now: NOW, leaseMs: researchLeaseMs(), budgetUsd: 1, paceMs: 0 });
      });
      expect(dead.type).toBe("research");

      // Past the lease, the next tick sweeps it back and researches it on its second attempt.
      expect(await r.tick(at(13 * MIN))).toMatchObject({ run: { outcome: "verified" } });
      expect(await research(tx, GOL)).toMatchObject({ state: "verified", attempts: 2 });
      const late = await r.db.tx("quotes", (q) =>
        recordResearch(q, dead as ResearchClaim, { outcome: "verified", cacheRow: { ...GOL, viscosityGrades: ["0W-20"], viscosity: "0W-20", classification: "", fillLiters: 3, fillKind: "em_servico", consultedAt: NOW.toISOString(), rawPayload: null, sourcePublisher: "x", sourceDocument: "x", sourcePage: "x", sourceAuthority: 3, sourceUrl: null }, sourcesReadAt: NOW }, { now: at(14 * MIN), leaseMs: researchLeaseMs() }),
      );
      expect(late).toEqual({ status: "lost" });
      expect(await tx.motulCompatibility.count({ where: { model: "Gol" } })).toBe(1);
      expect((await runs(tx, GOL)).map((run) => run.outcome)).toEqual(["lost", "verified"]);
    }));
  });
});
