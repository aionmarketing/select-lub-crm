/**
 * Shared fixtures for the research jobs' live suites (background-oil-research PR 3): fake ports
 * that never reach a provider and record whether a transaction was open when they were called,
 * a database handle that counts open `db.tx` calls, and seeding helpers.
 *
 * The fakes are ONE ports object, like the production one (D21): a suite scripts what each port
 * answers and feeds the run's meter the way a real port would report its requests.
 */
import type { DbClient } from "@select-lub/core/db";
import { createDb, type Db } from "../src/kernel/db.js";
import type { ResearchTecfilAnswer } from "../src/modules/quotes/internal/catalog/tecfil-lookup.js";
import type { CallEvent } from "../src/modules/quotes/internal/model-calls/meter.js";
import {
  createOilSpecExtractor,
  type ExtractedOilSpec,
  type OilSpecEscalator,
  type OilSpecExtractor,
  type RetrieveResult,
  type RetrievedSource,
} from "../src/modules/quotes/internal/pipeline/oil-spec.js";
import type { OilResearchPorts, ResearchRunContext } from "../src/modules/quotes/internal/research/ports.js";
import { DEFAULT_OIL_RESEARCH_SETTINGS, type OilResearchSettings } from "../src/modules/quotes/internal/research/settings.js";
import { createStoredManualRetriever } from "../src/modules/quotes/internal/retrieval/stored-manuals.js";
import { createPrismaOilQuoteStore } from "../src/modules/quotes/internal/store/prisma.js";
import { runInTransactionOnTx } from "../src/testing/index.js";

export const NOW = new Date("2026-09-26T15:00:00.000Z");
export const MIN = 60_000;
export const at = (ms: number) => new Date(NOW.getTime() + ms);

/** Settings with no pacing, so a test's backfill row is claimed at once unless it says otherwise. */
export const SETTINGS: OilResearchSettings = { ...DEFAULT_OIL_RESEARCH_SETTINGS, backfillPaceMs: 0 };

/**
 * A database handle on the test transaction that counts the `db.tx` calls open right now.
 *
 * @param afterTx - Awaited after each committed `db.tx`: a case uses it to act at an exact point
 *   of a run, such as just after the verified record committed.
 */
export function trackedDb(tx: DbClient, afterTx?: () => Promise<void>): Db & { open(): number } {
  const inner = createDb(tx, runInTransactionOnTx(tx));
  let open = 0;
  return {
    client: inner.client,
    open: () => open,
    tx: async (module, fn, runner) => {
      open += 1;
      let value;
      try {
        value = await inner.tx(module, fn, runner);
      } finally {
        open -= 1;
      }
      if (afterTx) await afterTx();
      return value;
    },
  };
}

/** A research model call a fake port reports, priced like the real one. */
export const modelCall = (output: number, extra: Partial<CallEvent> = {}): CallEvent => ({
  model: "gpt-6.1-sol",
  usage: { input: 1_000, cachedInput: 0, reasoning: 200, output },
  timedOut: false,
  accepted: true,
  effort: "medium",
  ...extra,
});

export const VERIFIED_SPEC: ExtractedOilSpec = { viscosityGrades: ["5W-40"], classification: "", fillLiters: 4, fillKind: "em_servico", engineCoverage: "one" };

export const page = (publisher: string, text: string, authority: 1 | 2 | 3 | 4 | 5 = 3, url?: string): RetrievedSource => ({
  publisher,
  document: `${publisher} — página`,
  page: "p. 1",
  authority,
  ...(url ? { url, classification: "manufacturer_manual" as const, excerpt: text } : {}),
  content: { kind: "text", text },
});

/** What a suite scripts; every field optional. */
export type FakeScript = {
  keySet?: boolean;
  /** What the heartbeat records for the web search; true by default. */
  searchAvailable?: boolean;
  /** What retrieval answers; it may call `ctx.step`, feed `ctx.meter` and `ctx.report`. */
  retrieve?: (ctx: ResearchRunContext) => Promise<RetrieveResult>;
  /** The text extractor (stored specs and Motul payloads are extracted in code). */
  extract?: OilSpecExtractor;
  escalate?: OilSpecEscalator;
  tecfil?: (ctx: ResearchRunContext) => Promise<ResearchTecfilAnswer>;
  /** A re-resolve reads the stored manual readings of this transaction. */
  storedReadingsOn?: DbClient;
};

/** What the fakes saw. */
export type FakeProbe = { calls: string[]; txOpenDuringCall: boolean; contexts: ResearchRunContext[] };

export const TECFIL_OK: ResearchTecfilAnswer = {
  result: {
    status: "ok",
    fitment: {
      application: { manufacturer: "VW", vehicle: "Gol", engine: "1.0" },
      matchedBy: { manufacturer: "exact", vehicle: "exact", engine: "exact" },
      oilFilters: [],
      fuelFilters: [],
    },
  },
  pickerFailed: false,
};

/**
 * @param db - The tracked handle: every fake port records whether a `db.tx` was open when called.
 */
export function fakePorts(db: { open(): number }, script: FakeScript = {}): { ports: OilResearchPorts; probe: FakeProbe } {
  const probe: FakeProbe = { calls: [], txOpenDuringCall: false, contexts: [] };
  const seen = (name: string) => {
    probe.calls.push(name);
    if (db.open() > 0) probe.txOpenDuringCall = true;
  };
  const defaultRetrieve = async (ctx: ResearchRunContext): Promise<RetrieveResult> => {
    await ctx.step("motul", async () => seen("motul"));
    return ctx.step("webSearch", async () => {
      seen("webSearch");
      ctx.meter.onToolCall({ answered: true });
      ctx.meter.onToolCall({ answered: true });
      ctx.meter.onCall(modelCall(300));
      return { status: "found", sources: [page("vw.com.br", "Óleo 5W-40, 4,0 L com filtro", 1, "https://vw.com.br/gol")] };
    });
  };
  const text: OilSpecExtractor = script.extract ?? (async () => VERIFIED_SPEC);
  const ports: OilResearchPorts = {
    keySet: () => script.keySet ?? true,
    searchAvailable: () => script.searchAvailable ?? true,
    specPorts: (ctx) => {
      probe.contexts.push(ctx);
      const stored = script.storedReadingsOn ? createStoredManualRetriever(createPrismaOilQuoteStore(script.storedReadingsOn)) : null;
      return {
        retrieve: async (identity) => {
          seen("retrieve");
          if (ctx.skipWebSearch && stored) return stored(identity);
          return (script.retrieve ?? defaultRetrieve)(ctx);
        },
        extract: createOilSpecExtractor(async (source, identity) => {
          seen("extract");
          ctx.meter.onCall(modelCall(500));
          return text(source, identity);
        }),
        selectPassage: async (source) => {
          seen("passage");
          return { status: "selected", source };
        },
        ...(script.escalate
          ? {
              escalate: async (input) => {
                seen("escalate");
                ctx.meter.onCall(modelCall(700));
                return script.escalate!(input);
              },
            }
          : {}),
      };
    },
    tecfil: (ctx) => async () => {
      seen("tecfil");
      return script.tecfil ? script.tecfil(ctx) : TECFIL_OK;
    },
  };
  return { ports, probe };
}

/** A vehicle of `identity` for a fresh customer. */
export async function vehicle(tx: DbClient, identity: { make: string; year: number; model: string; version: string }, updatedAt?: Date) {
  const customer = await tx.customer.create({ data: { origin: "CRM", status: "ACTIVE" } });
  return tx.vehicle.create({
    data: { customerId: customer.id, origin: "CRM", ...identity, ...(updatedAt ? { createdAt: updatedAt, updatedAt } : {}) },
  });
}

/** A manual candidate the manual queue picks for `identity` (a manufacturer manual, labelled with the model). */
export async function manualCandidate(tx: DbClient, identity: { make: string; year: number; model: string; version: string }, url: string) {
  await tx.oilSourceCandidate.create({
    data: {
      ...identity,
      url,
      publisher: "vw.com.br",
      classification: "manufacturer_manual",
      tier: 1,
      label: `Manual ${identity.model} ${identity.year}`,
      foundAt: NOW,
    },
  });
}

/** A stored spec a reading verified. */
export const readingSpec = (grades: string[], liters: number) => ({
  viscosityGrades: grades,
  classification: "",
  fillLiters: liters,
  fillKind: "em_servico",
  engineCoverage: "one",
  enginesNamed: [],
  publisher: "vw.com.br",
  document: "Manual Gol 2021",
  sourceClass: "manufacturer_manual",
});
