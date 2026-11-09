/**
 * Test design (testing-strategy) — Motul degrades after hours of failure (oil-research-web-retrieval D6)
 *
 * SUT: `quotes/run-oil-research`'s tick over the REAL Motul adapter, chain and web gate with an
 *   injected Oil Advisor call and an empty web, on a scratch database; the runner row's
 *   `motul_failing_since`. Module role: `quotes`.
 *
 * Why a scratch database: the claims take any due row, and the runner row is shared.
 *
 * Oracle: owner's decision 2026-10-07 and specs `quotes/motul-client-resilience` "A gateway that has
 *   been failing for hours is degraded, and no longer makes research incomplete".
 *
 * Axes
 *   D1 Motul's answer — unavailable / an answer ("not covered")
 *   D2 how long it has been failing — not yet / past MOTUL_DEGRADED_AFTER_MS (6 h)
 *   D3 anything else wrong — the web search itself is down / nothing
 *
 * Sampled cells (one row per \`it\`)
 *   first failure                | D1,D2 | the run is an outage to retry, the moment is stamped
 *   failing 7 h, web empty       | D1,D2 | \`no_spec\`, not a retry; the moment is kept; the log says degraded
 *   an answer                    | D1    | the moment is cleared, and the next failure starts a new count
 *   web search down, degraded    | D3    | still an outage: only Motul's own failure stops counting
 *   breaker, degraded            | D2    | three identities ending \`no_spec\` do not pause research
 *   breaker, not degraded        | D2    | three identities ending as outages still pause it (unchanged)
 *   another worker process       | D2    | a second runner reads the stored moment, not its own count
 *
 * Out of scope: the adapter in isolation (sources.motul.test.ts), the settings (worker-settings.test.ts).
 */
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { shouldRunLiveTests, type DbClient } from "@select-lub/core/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ResolveOilResult } from "../src/kernel/clients/motul/index.js";
import type { RetrieveResult } from "../src/modules/quotes/internal/pipeline/oil-spec.js";
import { identityKey } from "../src/modules/quotes/internal/research/identity-key.js";
import { enqueueResearch, type EnqueueRequest } from "../src/modules/quotes/internal/research/research-store.js";
import { readRunnerStatus } from "../src/modules/quotes/internal/research/runner-row.js";
import { chainRetrievers, createMotulRetriever, gateWebSearch } from "../src/modules/quotes/internal/retrieval/sources.js";
import { createOutageBreaker, runOilResearchTick } from "../src/modules/quotes/run-oil-research/index.js";
import { withConnectRetry, withTestTransaction } from "../src/testing/index.js";
import { at, fakePorts, MIN, NOW, SETTINGS, trackedDb } from "./oil-research-harness.js";
import { createScratchDatabase, type ScratchDatabase } from "./scratch-database.js";

const hasDatabase = shouldRunLiveTests();
const repoRoot = resolve(import.meta.dirname, "../../..");
const SCRATCH_SETUP_TIMEOUT_MS = 180_000;
const HOUR = 60 * MIN;

const ARGO = { make: "Fiat", year: 2021, model: "Argo", version: "1.0 Firefly" };
const GOL = { make: "Volkswagen", year: 2021, model: "Gol", version: "1.0 FLEX 12V 4P" };
const ONIX = { make: "Chevrolet", year: 2021, model: "Onix", version: "1.0 Flex" };
type Identity = typeof ARGO;
/** What the fakes answer: Motul's Oil Advisor and the web search, changed by a case as time passes. */
type World = { motul: ResolveOilResult; web: RetrieveResult };

const quoteOpen = (identity: Identity): EnqueueRequest => ({ identity, kind: "full", priority: 0, trigger: "quote_open" });
const research = (tx: DbClient, identity: Identity) => tx.oilResearch.findUniqueOrThrow({ where: { identityKey: identityKey(identity)! } });
const failingSince = async (tx: DbClient) => (await tx.oilResearchRunner.findUnique({ where: { id: "runner" } }))?.motulFailingSince ?? null;

const DOWN: ResolveOilResult = { status: "unavailable" };
const NOT_COVERED: ResolveOilResult = { status: "unmatched", field: "model", options: [] };

describe.skipIf(!hasDatabase)("Motul degrades after hours of failure — live, on a scratch database", () => {
  let scratch: ScratchDatabase | undefined;
  let prisma!: PrismaClient;

  beforeAll(async () => {
    scratch = await createScratchDatabase(process.env.DATABASE_URL ?? "", "oil_research_motul", repoRoot);
    prisma = withConnectRetry(new PrismaClient({ datasourceUrl: scratch.url }));
  }, SCRATCH_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await prisma?.$disconnect();
    } finally {
      await scratch?.drop();
    }
  }, SCRATCH_SETUP_TIMEOUT_MS);

  afterEach(() => vi.restoreAllMocks());

  const inTx = (fn: (tx: DbClient) => Promise<void>) => () => withTestTransaction(prisma, fn);

  /** A worker process: its own breaker and ports, Motul's answer and the web's read from the shared `world`. */
  function worker(tx: DbClient, world: World, identity: () => Identity) {
    const db = trackedDb(tx);
    const { ports } = fakePorts(db, {
      retrieve: async (ctx) => {
        const motul = createMotulRetriever({ degraded: ctx.motulDegraded, report: ctx.reportMotul, resolve: async () => world.motul });
        const local = chainRetrievers([(id) => ctx.step("motul", () => motul(id))]);
        return gateWebSearch(local, async () => world.web)(identity());
      },
    });
    const breaker = createOutageBreaker(SETTINGS.outageBreaker);
    return {
      tick: (now = NOW) => runOilResearchTick({ db, ports, settings: SETTINGS, now: () => now, breaker }, new AbortController().signal),
      enqueue: (request: EnqueueRequest, now = NOW) => db.tx("quotes", (q) => enqueueResearch(q, request, now)),
    };
  }

  const EMPTY_WEB: RetrieveResult = { status: "none" };

  it("treats the first failure as an outage and stamps the moment", inTx(async (tx) => {
    const w = worker(tx, { motul: DOWN, web: EMPTY_WEB }, () => ARGO);
    await w.enqueue(quoteOpen(ARGO));

    expect(await w.tick()).toMatchObject({ run: { outcome: "unavailable", state: "queued" } });

    expect(await failingSince(tx)).toEqual(NOW);
  }));

  it("records no source, not a retry, once Motul has been failing for six hours, and keeps the moment", inTx(async (tx) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const w = worker(tx, { motul: DOWN, web: EMPTY_WEB }, () => ARGO);
    await w.enqueue(quoteOpen(ARGO));
    await w.tick();

    expect(await w.tick(at(7 * HOUR))).toMatchObject({ run: { outcome: "no_spec", state: "no_spec" } });

    expect(await research(tx, ARGO)).toMatchObject({ state: "no_spec", searched: true });
    expect(await failingSince(tx)).toEqual(NOW);
    expect(info.mock.calls.some(([tag, line]) => tag === "oil-research" && String(line).includes('"motul":"degraded"'))).toBe(true);
  }));

  it("does not degrade before six hours", inTx(async (tx) => {
    const w = worker(tx, { motul: DOWN, web: EMPTY_WEB }, () => ARGO);
    await w.enqueue(quoteOpen(ARGO));
    await w.tick();

    expect(await w.tick(at(5 * HOUR + 59 * MIN))).toMatchObject({ run: { outcome: "unavailable" } });
  }));

  it("clears the moment on any answer, and the next failure starts a new count", inTx(async (tx) => {
    const world: World = { motul: DOWN, web: EMPTY_WEB };
    const w = worker(tx, world, () => ARGO);
    await w.enqueue(quoteOpen(ARGO));
    await w.tick();
    expect(await failingSince(tx)).toEqual(NOW);

    world.motul = NOT_COVERED;
    await w.tick(at(7 * HOUR));
    expect(await failingSince(tx)).toBeNull();

    world.motul = DOWN;
    await w.enqueue({ identity: ARGO, kind: "refetch", priority: 0, trigger: "refetch" }, at(8 * HOUR));
    expect(await w.tick(at(8 * HOUR))).toMatchObject({ run: { outcome: "unavailable" } });
    expect(await failingSince(tx)).toEqual(at(8 * HOUR));
  }));

  it("is still an outage when the web search itself is down, whatever Motul is", inTx(async (tx) => {
    await tx.oilResearchRunner.create({ data: { id: "runner", motulFailingSince: at(-7 * HOUR), updatedAt: NOW } });
    const w = worker(tx, { motul: DOWN, web: { status: "unavailable" } }, () => ARGO);
    await w.enqueue(quoteOpen(ARGO));

    expect(await w.tick()).toMatchObject({ run: { outcome: "unavailable", state: "queued" } });
  }));

  it("reads the moment another worker process stored", inTx(async (tx) => {
    const world: World = { motul: DOWN, web: EMPTY_WEB };
    const first = worker(tx, world, () => ARGO);
    const second = worker(tx, world, () => GOL);
    await first.enqueue(quoteOpen(ARGO));
    await first.tick();

    await second.enqueue(quoteOpen(GOL), at(7 * HOUR));

    expect(await second.tick(at(7 * HOUR))).toMatchObject({ run: { outcome: "no_spec" } });
  }));

  describe("the outage breaker", () => {
    const identities = [ARGO, GOL, ONIX];

    async function threeIdentities(tx: DbClient, world: World, now: Date) {
      let current: Identity = ARGO;
      const w = worker(tx, world, () => current);
      const outcomes: string[] = [];
      for (const identity of identities) {
        current = identity;
        await w.enqueue(quoteOpen(identity), now);
        const result = await w.tick(now);
        outcomes.push("run" in result ? result.run.outcome : result.outcome);
      }
      return outcomes;
    }

    it("does not pause research for three identities ending as no source while Motul is degraded", inTx(async (tx) => {
      await tx.oilResearchRunner.create({ data: { id: "runner", motulFailingSince: at(-7 * HOUR), updatedAt: NOW } });

      const outcomes = await threeIdentities(tx, { motul: DOWN, web: EMPTY_WEB }, NOW);

      expect(outcomes).toEqual(["no_spec", "no_spec", "no_spec"]);
      expect(await readRunnerStatus(tx)).toMatchObject({ pausedReason: null });
    }));

    it("still pauses research for three outages in a row while Motul is not degraded", inTx(async (tx) => {
      const outcomes = await threeIdentities(tx, { motul: DOWN, web: EMPTY_WEB }, NOW);

      expect(outcomes).toEqual(["unavailable", "unavailable", "unavailable"]);
      expect(await readRunnerStatus(tx)).toMatchObject({ pausedReason: "provider" });
    }));
  });
});
