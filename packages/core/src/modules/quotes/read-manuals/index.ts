/**
 * Slice `quotes/read-manuals`: the worker job that reads each ingested manual once for each
 * identity that queued it (ingest-harvested-manuals PR 3, D7; GitHub #77).
 *
 * One tick:
 *   1. claims the oldest due reading of an ingested manual (leased);
 *   2. loads the manual's stored pages and its source — no download;
 *   3. locates that identity's pages (D4), selects the passage and extracts it — OUTSIDE any
 *      transaction, with the same model selector and extractor the quote pipeline uses;
 *   4. stores the outcome as that identity's reading: `verified` with the extraction and its
 *      page, `stated_nothing`, or `failed` (a model failure, retried later) — a compare-and-set
 *      on the claim, so a reading claimed again meanwhile is not overwritten.
 * A quote then uses a verified reading as a source without calling a model for it.
 *
 * Background research spend (background-oil-research D11, D13, D19): the claim takes the reading
 * a waiting research needs first (its priority, then its deadline); past the day's budget it
 * takes only a reading an identity waits on at priority 0 or 1; each reading writes a run row
 * (`kind = manual_reading`, path `reading`) with its meter, which counts toward the day's spend;
 * and a stop releases the reading back to `pending` with its attempt refunded, at once.
 *
 * `MANUAL_INGESTION_ENABLED=false` stops this job too. Without `OPENAI_API_KEY` the job claims
 * nothing and logs that it is waiting for the key: a reading claimed without one would only spend
 * an attempt (it has three, then it is a definite `failed`), so the readings stay `pending` until
 * the key is set.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../../../kernel/db.js";
import type { Job } from "../../../kernel/jobs.js";
import { createUsageMeter } from "../internal/model-calls/meter.js";
import { moneySetting } from "../internal/model-calls/money.js";
import type { ModelPortOptions } from "../internal/model-calls/ports.js";
import { configuredResearchModelKey, researchModel } from "../internal/model-calls/research-model.js";
import { manualIngestionEnabled } from "../internal/manuals/limits.js";
import { pagesToSelector } from "../internal/manuals/locate-pages.js";
import { readForIdentity, type ReadingOutcome } from "../internal/manuals/read-for-identity.js";
import { claimNextReading, loadReadingInput, recordReading, releaseReading, type ReadingClaim } from "../internal/manuals/reading-store.js";
import { budgetReached, DEFAULT_DAILY_BUDGET_USD, daySpendUsd } from "../internal/research/budget.js";
import { identityKey } from "../internal/research/identity-key.js";
import { progressData, writeRun } from "../internal/research/run-progress.js";
import { createOilSpecExtractor, type OilSpecExtractor } from "../internal/pipeline/oil-spec.js";
import { createModelPassageSelector, type PassageSelector } from "../internal/pipeline/passage-selector.js";
import { createModelOilSpecExtractor } from "../internal/pipeline/spec-extractor.js";
import { limitsFor } from "../internal/model-calls/limits.js";

/** The job's interval, when `WORKER_MANUAL_INGEST_MS` is unset: the same as ingestion's. */
export const READ_MANUALS_EVERY_MS = 60_000;

/**
 * A reading's lease: `3 × OIL_RESEARCH_CALL_TIMEOUT_MS + 60 s` — one selector call and an extraction
 * with its retry, each up to the call ceiling of its model and effort, plus a minute of slack
 * (background-oil-research D2, D20): 13 min on the placeholder row.
 *
 * @returns The lease, milliseconds, from the reading model's limits.
 */
export function readingLeaseMs(): number {
  const { model, effort } = researchModel();
  return 3 * limitsFor(model, effort).callMs + 60_000;
}

/** A reading's two model ports, built per reading over its meter and signal (background-oil-research D3, D19). */
export type ReadingPorts = { selectPassage: PassageSelector; extract: OilSpecExtractor };

/** What the job needs, held in the closure the registration builds. */
export type ReadManualsDeps = {
  db: Db;
  /** Passage selector; tests inject one. Defaults to the research model's. */
  selectPassage?: PassageSelector;
  /** Extractor; tests inject one. Defaults to the research model's. */
  extract?: OilSpecExtractor;
  /**
   * Builds both ports for one reading, over its meter and signal: the production model ports when
   * absent (and when neither port above is injected). Tests that meter a reading pass it.
   */
  portsFor?: (options: ModelPortOptions) => ReadingPorts;
  /** The model recorded as the reader. Defaults to the research model. */
  readBy?: string;
  /** The daily budget (D13); `OIL_RESEARCH_DAILY_BUDGET_USD`, parsed strictly, when absent. */
  budgetUsd?: number;
  now?: () => Date;
  everyMs?: number;
};

/** What one tick did, for tests and logs. */
export type ReadTickResult = {
  readingId: string | null;
  outcome: "verified" | "stated_nothing" | "failed" | "lost" | "released" | "idle" | "off" | "no_key";
  citedPage?: string | null;
};

/** The reading's ports: the injected ones, else `portsFor`, else the research model's over the reading's meter and signal. */
function portsForReading(deps: ReadManualsDeps, options: ModelPortOptions): ReadingPorts {
  if (deps.portsFor) return deps.portsFor(options);
  return {
    selectPassage: deps.selectPassage ?? createModelPassageSelector(options),
    extract: deps.extract ?? createOilSpecExtractor(createModelOilSpecExtractor(options)),
  };
}

function logReading(claim: ReadingClaim, outcome: string, detail: Record<string, unknown>): void {
  console.info(
    "manual-read-identity",
    JSON.stringify({ url: claim.url, identity: [claim.make, claim.year, claim.model, claim.version].join(" "), outcome, ...detail }),
  );
}

/**
 * Runs one tick.
 *
 * @param deps - The job's dependencies.
 */
export async function readNextManual(deps: ReadManualsDeps, stop: AbortSignal = new AbortController().signal): Promise<ReadTickResult> {
  if (!manualIngestionEnabled()) return { readingId: null, outcome: "off" };
  // Production reads with the research model; without its key a claim would only spend an attempt.
  if (!deps.extract && !deps.portsFor && !process.env.OPENAI_API_KEY?.trim()) {
    console.warn("manual-read-identity", JSON.stringify({ outcome: "no_key", why: "OPENAI_API_KEY is not set; readings wait" }));
    return { readingId: null, outcome: "no_key" };
  }
  if (stop.aborted) return { readingId: null, outcome: "idle" };
  const now = deps.now ?? (() => new Date());
  const budgetUsd = deps.budgetUsd ?? moneySetting("OIL_RESEARCH_DAILY_BUDGET_USD", DEFAULT_DAILY_BUDGET_USD);
  // The claim and its run row commit together (D13): the day's spend counts every reading.
  const claimed = await deps.db.tx("quotes", async (tx) => {
    const at = now();
    // Past the budget only a reading an attended identity waits on is claimed (D13).
    const capped = budgetReached(await daySpendUsd(tx, at), budgetUsd);
    const claim = await claimNextReading(tx, at, readingLeaseMs(), { capped });
    if (!claim) return null;
    const runId = randomUUID();
    await tx.oilResearchRun.create({
      data: {
        id: runId,
        researchId: null,
        identityKey: identityKey(claim) ?? [claim.year, claim.make, claim.model, claim.version].join("|"),
        kind: "manual_reading",
        trigger: "manual_reading",
        path: "reading",
        startedAt: at,
        researchModel: configuredResearchModelKey(),
      },
    });
    return { claim, runId };
  });
  if (!claimed) return { readingId: null, outcome: "idle" };
  const { claim, runId } = claimed;
  const meter = createUsageMeter();
  const flush = () => progressData({ meter: meter.snapshot() });

  // A stop releases the reading at once — pending, its attempt refunded — without waiting for
  // the model calls, which the same signal aborts (D19).
  let release: Promise<boolean> | null = null;
  const onStop = () => {
    release ??= deps.db
      .tx("quotes", async (tx) => {
        const held = await releaseReading(tx, claim);
        if (held) await writeRun(tx, runId, { ...flush(), finishedAt: now(), outcome: "released" });
        return held;
      })
      .catch(() => false);
  };
  if (stop.aborted) onStop();
  else stop.addEventListener("abort", onStop, { once: true });
  // A reading whose claim was lost, or that threw, still spent: its run row is closed `lost` with
  // the meter's cost, so the day's sum counts it (D13; review of #186).
  const closeLost = () =>
    deps.db.tx("quotes", (tx) => writeRun(tx, runId, { ...flush(), finishedAt: now(), outcome: "lost" })).catch(() => undefined);

  try {
    const input = await deps.db.tx("quotes", (tx) => loadReadingInput(tx, claim.url));
    const identity = { make: claim.make, year: claim.year, model: claim.model, version: claim.version };

    // The selector and the extractor run between transactions, never inside one.
    const ports = portsForReading(deps, { meter, signal: stop });
    const outcome = input
      ? await readForIdentity({ url: claim.url, pages: input.pages, identity, meta: input.meta, k: pagesToSelector() }, ports).catch(
          (): ReadingOutcome => ({ status: "failed", why: "the reading was interrupted" }),
        )
      : ({ status: "failed", why: "no stored document, or no candidate names its class" } as const);

    if (stop.aborted) {
      const released = await release!;
      if (!released) await closeLost();
      logReading(claim, released ? "released" : "lost_lease", {});
      return { readingId: claim.id, outcome: released ? "released" : "lost" };
    }
    const readBy = deps.readBy ?? researchModel().model;
    const held = await deps.db.tx("quotes", async (tx) => {
      const recorded = await recordReading(tx, claim, input?.documentId ?? null, outcome, readBy, now());
      if (recorded) await writeRun(tx, runId, { ...flush(), finishedAt: now(), outcome: outcome.status });
      return recorded;
    });
    if (!held) {
      await closeLost();
      logReading(claim, "lost_lease", {});
      return { readingId: claim.id, outcome: "lost" };
    }
    const citedPage = outcome.status === "failed" ? null : outcome.citedPage;
    logReading(claim, outcome.status, { citedPage, ...(outcome.status === "verified" ? {} : { why: outcome.why }) });
    return { readingId: claim.id, outcome: outcome.status, citedPage };
  } catch (error) {
    // A release that committed already closed the row as `released`.
    if (!release || !(await release)) await closeLost();
    throw error;
  } finally {
    stop.removeEventListener("abort", onStop);
    if (release) await release;
  }
}

/** @returns The registered job: `quotes/read-manuals`. */
export function job(deps: ReadManualsDeps): Job {
  return {
    name: "quotes/read-manuals",
    everyMs: deps.everyMs ?? READ_MANUALS_EVERY_MS,
    run: async (stop) => {
      await readNextManual(deps, stop);
    },
  };
}
