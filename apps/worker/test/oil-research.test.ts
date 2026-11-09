/**
 * Test design (testing-strategy) — the worker's background oil research
 *
 * SUT: `startWorker`'s registration of `quotes/sweep-oil-research` and `quotes/run-oil-research`,
 *   its shutdown through the real `stop` (the kernel's `createStop`: stop the jobs, then `after`,
 *   which disconnects the shared Prisma client, then `exit`), and the committed configuration that
 *   switches research on and off: `apps/worker/fly.toml`, this project's `vitest.config.ts`, the
 *   loop table in `src/README.md`.
 *
 * Oracle: background-oil-research D9 (the kill switch: registered only with a database and
 *   `OIL_RESEARCH_ENABLED` exactly `"true"`), D19 (the release commits before the client
 *   disconnects; `kill_timeout = 30`), D21 (the test env pins research off whatever `.env` says)
 *   and the `deploy` delta; task 3.6's and 3.8's Verify lists.
 *
 * The live case runs in the rollback harness (`withTestTransaction`) with fake ports — ONE
 *   object, as production's — so it reaches no provider. The shared client's disconnect is a spy
 *   that reads the research row at the moment it is called: what it proves is the ORDER, that the
 *   release had been written by then. Module role of the jobs' writes: `quotes`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma, type DbClient } from "@select-lub/core/db";
import { kernel } from "@select-lub/core";
import type { OilResearchPorts } from "@select-lub/core/modules/quotes";
import { describeWithDatabase, runInTransactionOnTx, withTestTransaction } from "@select-lub/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWorker } from "../src/worker.js";

const RESEARCH_JOBS = ["quotes/sweep-oil-research", "quotes/run-oil-research"];
const here = import.meta.dirname;

/** A handle that must never be used: registration alone does not touch the database. */
const unusedDb: kernel.Db = {
  client: {} as never,
  tx: async () => {
    throw new Error("the database was used");
  },
};

/** Ports that answer nothing; the registration cases never tick. */
const inertPorts: OilResearchPorts = {
  keySet: () => true,
  searchAvailable: () => true,
  specPorts: () => {
    throw new Error("a port was built");
  },
  tecfil: () => {
    throw new Error("a port was built");
  },
};

/** Starts the worker with every interval far off, then stops it; returns what it registered. */
async function registered(options: Parameters<typeof startWorker>[0]): Promise<{ jobs: string[]; logs: string[] }> {
  const logs: string[] = [];
  const exit = vi.fn();
  const far = 3_600_000;
  const worker = startWorker({ heartbeatMs: far, manualIngestMs: far, oilResearchTickMs: far, oilResearchSweepMs: far, log: (line) => logs.push(line), exit, ...options });
  worker.stop("SIGTERM");
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  return { jobs: worker.jobs, logs };
}

describe("the worker's oil research switch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers both research jobs only with a database and research switched on", async () => {
    if (prisma) vi.spyOn(prisma, "$disconnect").mockResolvedValue(undefined);

    expect((await registered({ db: unusedDb, oilResearch: true, oilResearchPorts: inertPorts })).jobs).toEqual(expect.arrayContaining(RESEARCH_JOBS));
    const off = await registered({ db: unusedDb, oilResearch: false, oilResearchPorts: inertPorts });
    expect(off.jobs.filter((name) => RESEARCH_JOBS.includes(name))).toEqual([]);
    expect(off.logs).toContain("oil research off (OIL_RESEARCH_ENABLED is not true)");
    const noDb = await registered({ oilResearch: true, oilResearchPorts: inertPorts });
    expect(noDb.jobs.filter((name) => RESEARCH_JOBS.includes(name))).toEqual([]);
  });

  it("registers no research job under the test env, whatever the developer's .env enables", async () => {
    if (prisma) vi.spyOn(prisma, "$disconnect").mockResolvedValue(undefined);
    // The config pins the switch off and blanks the key; Vitest applies `test.env` over the
    // process env, so a `.env` with OIL_RESEARCH_ENABLED=true loaded before it loses.
    const config = readFileSync(resolve(here, "../vitest.config.ts"), "utf8");
    for (const pin of ['OIL_RESEARCH_ENABLED: "false"', 'OPENAI_API_KEY: ""']) expect(config).toContain(pin);
    expect(process.env.OIL_RESEARCH_ENABLED).toBe("false");
    expect(process.env.OPENAI_API_KEY ?? "").toBe("");

    const { jobs } = await registered({ db: unusedDb, oilResearchPorts: inertPorts });

    expect(jobs.filter((name) => RESEARCH_JOBS.includes(name))).toEqual([]);
  });

  // switch-oil-research-to-openai task 1.5: the model in force is said once at start-up, and a
  // (model, effort) with no measured limits is said too, so a placeholder row is never silent.
  describe("the start-up report of the research model", () => {
    afterEach(() => {
      delete process.env.OIL_RESEARCH_REASONING_EFFORT;
    });

    it("says the research model and effort, and nothing about limits when they are measured", async () => {
      if (prisma) vi.spyOn(prisma, "$disconnect").mockResolvedValue(undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const { logs } = await registered({ db: unusedDb, oilResearchPorts: inertPorts });

      expect(logs.some((line) => line.startsWith("oil-research-model ") && line.includes('"model":"gpt-6.1-sol"') && line.includes('"effort":"medium"'))).toBe(true);
      expect(logs.some((line) => line.startsWith("openai-limits"))).toBe(false);
    });

    it("also says a pair that runs on the placeholder row", async () => {
      if (prisma) vi.spyOn(prisma, "$disconnect").mockResolvedValue(undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      process.env.OIL_RESEARCH_REASONING_EFFORT = "high";

      const { logs } = await registered({ db: unusedDb, oilResearchPorts: inertPorts });

      expect(logs.some((line) => line.startsWith("openai-limits ") && line.includes('"effort":"high"') && line.includes('"runsOn":"placeholder"'))).toBe(true);
    });
  });

  it("lists the four quotes jobs in the loop table", () => {
    const readme = readFileSync(resolve(here, "../src/README.md"), "utf8");
    for (const name of ["quotes/ingest-manuals", "quotes/read-manuals", ...RESEARCH_JOBS]) expect(readme).toContain(name);
  });

  it("switches research on in production and gives the machine 30 s to release a run", () => {
    const toml = readFileSync(resolve(here, "../fly.toml"), "utf8");
    expect(toml).toMatch(/^kill_timeout = 30$/m);
    const env = toml.slice(toml.indexOf("[env]"), toml.indexOf("\n[", toml.indexOf("[env]") + 1));
    expect(env).toMatch(/^\s*OIL_RESEARCH_ENABLED = "true"$/m);
  });
});

describeWithDatabase("the worker's shutdown during a research run", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("commits the release before the shared client disconnects", () =>
    withTestTransaction(prisma!, async (tx: DbClient) => {
      const db = kernel.createDb(tx, runInTransactionOnTx(tx));
      const identity = { make: "Marca de teste", year: 2031, model: `Modelo ${Date.now()}`, version: "1.0 desligamento" };
      await tx.oilResearch.create({
        data: { id: `stop-${Date.now()}`, identityKey: `2031|MARCADETESTE|${identity.model.replace(/\W/g, "").toUpperCase()}|10DESLIGAMENTO`, ...identity, state: "queued", priority: 0, trigger: "quote_open", queuedAt: new Date(), cycleQueuedAt: new Date(), requestedAt: new Date() },
      });
      let searching!: () => void;
      const started = new Promise<void>((done) => (searching = done));
      const ports: OilResearchPorts = {
        keySet: () => true,
        searchAvailable: () => true,
        specPorts: (ctx) => ({
          retrieve: () =>
            ctx.step("webSearch", async () => {
              ctx.meter.onToolCall({ answered: true });
              searching();
              await new Promise((done) => ctx.signal.addEventListener("abort", done, { once: true }));
              return { status: "none" };
            }),
          extract: async () => null,
        }),
        tecfil: () => async () => ({ result: { status: "unavailable" }, pickerFailed: false }),
      };
      let atDisconnect: { state: string; attempts: number } | null = null;
      vi.spyOn(prisma!, "$disconnect").mockImplementation(async () => {
        atDisconnect = await tx.oilResearch.findFirstOrThrow({ where: { make: identity.make, model: identity.model }, select: { state: true, attempts: true } });
      });
      const exit = vi.fn();
      const far = 3_600_000;

      const worker = startWorker({
        db,
        oilResearch: true,
        oilResearchPorts: ports,
        oilResearchTickMs: 20,
        oilResearchSweepMs: far,
        heartbeatMs: far,
        manualIngestion: false,
        log: () => undefined,
        exit,
      });
      await started;
      worker.stop("SIGTERM");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 5_000 });

      expect(atDisconnect).toEqual({ state: "queued", attempts: 0 });
      const run = await tx.oilResearchRun.findFirstOrThrow({ where: { identityKey: { startsWith: "2031|MARCADETESTE" } } });
      expect(run).toMatchObject({ outcome: "released", searchCalls: 1 });
    }));
});
