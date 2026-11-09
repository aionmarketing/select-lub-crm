/**
 * Slice `quotes/ingest-manuals`: the worker job that reads the manufacturer manuals the oil-spec
 * web search records (ingest-harvested-manuals PR 2; GitHub #77).
 *
 * One tick:
 *   1. queues, for every identity with recorded candidates, the manuals D1 picks;
 *   2. claims the oldest due URL (leased, so a worker that dies mid-read does not hold it), and
 *      counts the attempt;
 *   3. downloads it, commits `parsing`, then extracts it — OUTSIDE any transaction — under the
 *      hard limits, one parse at a time per process;
 *   4. stores its pages, or records why it could not be read.
 * Committing the attempt and the `parsing` state first means a manual that kills the worker
 * mid-parse is counted, and marked `failed` after three, instead of crash-looping it.
 * One document per tick, so one slow manual never holds up the worker's other loops.
 *
 * Once deployed the production worker starts downloading recorded manuals on its own: the
 * owner approved background ingestion (2026-09-25). `MANUAL_INGESTION_ENABLED=false` stops it,
 * both at registration and at every tick.
 *
 * The stored pages are read by `quotes/read-manuals`, once per identity that queued the URL.
 */
import type { Db } from "../../../kernel/db.js";
import type { Job } from "../../../kernel/jobs.js";
import type { ManualHttp } from "../internal/manuals/document-fetcher.js";
import { createGuardedHttp } from "../internal/net/guarded-http.js";
import {
  claimNextManual,
  manualsPerIdentity,
  markParsing,
  queueManuals,
  recordManualFailure,
  recordManualRead,
} from "../internal/manuals/ingestion-store.js";
import { manualIngestionEnabled, manualLimits } from "../internal/manuals/limits.js";
import { readManual, type ManualReadLog } from "../internal/manuals/read-manual.js";
import { createUnpdfTextExtractor, type ManualTextExtractor } from "../internal/manuals/text-extractor.js";

/** The job's interval, when `WORKER_MANUAL_INGEST_MS` is unset. */
export const INGEST_MANUALS_EVERY_MS = 60_000;

/** Beyond a download plus a parse, before a claim is taken as abandoned. */
const LEASE_MARGIN_MS = 60_000;

export { manualIngestionEnabled };

/** What the job needs, held in the closure `createManualIngestionJobs` builds. */
export type IngestManualsDeps = {
  db: Db;
  /** HTTP client; tests inject one. Defaults to the SSRF-guarded client. */
  http?: ManualHttp;
  /** Text extractor; tests inject one. Defaults to the `unpdf` adapter. */
  extract?: ManualTextExtractor;
  log?: (entry: ManualReadLog) => void;
  now?: () => Date;
  /** Job interval; defaults to {@link INGEST_MANUALS_EVERY_MS}. */
  everyMs?: number;
};

/** What one tick did, for tests and logs. `lost`: another worker claimed the URL meanwhile. */
export type IngestTickResult = { queued: number; url: string | null; outcome: "read" | "refused" | "failed" | "lost" | "idle" | "off" };

/** Thrown into readManual's `beforeParse` when the claim was lost, so nothing is parsed. */
class LostLease extends Error {
  override name = "LostLease";
}

/** One line when this worker finds its claim taken: the lease ran out and another claimed the URL. */
function logLostLease(url: string, attempts: number, at: "parse" | "record"): void {
  console.warn("manual-ingest", JSON.stringify({ url, outcome: "lost_lease", attempts, at }));
}

/**
 * Runs one tick.
 *
 * @param deps - The job's dependencies.
 */
export async function ingestNextManual(deps: IngestManualsDeps): Promise<IngestTickResult> {
  if (!manualIngestionEnabled()) return { queued: 0, url: null, outcome: "off" };
  const now = deps.now ?? (() => new Date());
  const limits = manualLimits();

  const queued = await deps.db.tx("quotes", (tx) => queueManuals(tx, manualsPerIdentity()));
  const claimed = await deps.db.tx("quotes", (tx) => claimNextManual(tx, now(), limits.fetchTimeoutMs + LEASE_MARGIN_MS));
  if (!claimed) return { queued, url: null, outcome: "idle" };

  // The network and the parse run between transactions, never inside one.
  // Set inside beforeParse; `as` keeps TypeScript from narrowing it to null here.
  let lostAt = null as "parse" | null;
  const read = await readManual(claimed.url, {
    http: deps.http ?? createGuardedHttp(),
    extract: deps.extract ?? createUnpdfTextExtractor(),
    limits,
    ...(deps.log ? { log: deps.log } : {}),
    now: () => now().getTime(),
    beforeParse: async () => {
      const held = await deps.db.tx("quotes", (tx) => markParsing(tx, claimed, now(), limits.parseTimeoutMs + LEASE_MARGIN_MS));
      if (!held) {
        lostAt = "parse";
        throw new LostLease("another worker holds this manual now");
      }
    },
  });
  if (lostAt) {
    logLostLease(claimed.url, claimed.attempts, lostAt);
    return { queued, url: claimed.url, outcome: "lost" };
  }

  // Every write is a compare-and-set on this claim: a lost one writes nothing.
  if (read.ok) {
    const documentId = await deps.db.tx("quotes", (tx) => recordManualRead(tx, claimed, read, now()));
    if (documentId === null) {
      logLostLease(claimed.url, claimed.attempts, "record");
      return { queued, url: claimed.url, outcome: "lost" };
    }
    return { queued, url: claimed.url, outcome: "read" };
  }
  const held = await deps.db.tx("quotes", (tx) => recordManualFailure(tx, claimed, read, now()));
  if (!held) {
    logLostLease(claimed.url, claimed.attempts, "record");
    return { queued, url: claimed.url, outcome: "lost" };
  }
  return { queued, url: claimed.url, outcome: read.definite ? "refused" : "failed" };
}

/** @returns The registered job: `quotes/ingest-manuals`. */
export function job(deps: IngestManualsDeps): Job {
  return {
    name: "quotes/ingest-manuals",
    everyMs: deps.everyMs ?? INGEST_MANUALS_EVERY_MS,
    run: async () => {
      await ingestNextManual(deps);
    },
  };
}
