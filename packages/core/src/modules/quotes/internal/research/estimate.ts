/**
 * The X–Y estimate (background-oil-research D14; `oil-research` "The expected duration is
 * estimated from observed runs").
 *
 * The estimate is a total counted from `requested_at` and stored on the research row at three
 * moments only — when a cycle's `requested_at` is set or a queued row is moved up (with the queue
 * term), at each claim, and on entering the manual wait — and never on a read. So the range and
 * the dialog's counter share one anchor, and a poll never changes the sentence.
 *
 * - The run range per path: with at least {@link MIN_RUNS_FOR_PERCENTILES} runs, P25 to P90;
 *   below, the defaults (search 1–5 min, manual 1–6 min; P50 of search 1 min).
 * - Minutes: X = max(1, ⌊lower / 60 s⌋), Y = max(X + 1, ⌈upper / 60 s⌉).
 * - The queue term: ⌈k × P50(search) / 60 s⌉ whole minutes, added to both bounds, k being the
 *   rows ahead in claim order plus one when another run is in progress.
 * - The populations: the path's last 200 runs finished within 30 days that ended with an answer,
 *   at least 1 s long. `search` is a stage-1 run's own duration; `manual` is the wait (from
 *   `wait_started_at` to the re-resolve's `queued_at`) plus the re-resolve's own run, only for
 *   re-resolves that ended a wait (`wait_ended`).
 */
import type { DbClient } from "@select-lub/core/db";
import { configuredResearchModelKey, LEGACY_RESEARCH_MODEL_KEY } from "../model-calls/research-model.js";

/** The two timing populations. */
export type EstimatePath = "search" | "manual";

/** A run range, in seconds. */
export type RunRange = { lowerS: number; upperS: number };

/** The percentiles a path's estimate is computed from. */
export type PathTimings = { range: RunRange; p50S: number };

/**
 * The defaults (D14), until n ≥ 20 runs replace them. Search, set by task 1.13 on 2026-09-27 from
 * one run timed at `high` plus the 2026-09-26 page reads: from the run itself (27 s, so X = 1) to
 * its web search (22.8 s) plus the read cap's three page reads at the slowest benchmarked read
 * (80.4 s each), 264 s, so Y = 5. Manual, from the Gol 2021 manual timed the same day: from the
 * measured wait plus re-resolve (21 s, so X = 1) to the two job ticks, the download and parse
 * timeouts, the slowest read, the runner's tick and the re-resolve (333 s, so Y = 6).
 */
export const DEFAULT_RUN_RANGES: Record<EstimatePath, RunRange> = {
  search: { lowerS: 60, upperS: 300 },
  manual: { lowerS: 60, upperS: 360 },
};

/**
 * An engine re-read's run range (D14, D24; orchestrator 2026-09-30): fixed at 1–2 minutes. Its runs
 * (path `engine_pick`) are in neither population — one extraction on stored text says nothing
 * about a search or a manual — so {@link loadPathTimings} never reads them.
 */
export const ENGINE_PICK_RUN_RANGE: RunRange = { lowerS: 60, upperS: 120 };

/**
 * P50 of the search path, when fewer than twenty runs are recorded: the measured web search
 * (22.8 s) plus one page read at the benchmark's median at `high` (4.5 s selector + 18.6 s
 * extraction), 46 s, rounded up to the minute the queue term counts in (task 1.13, 2026-09-27).
 */
export const DEFAULT_SEARCH_P50_S = 60;

/** Below this many runs, the defaults apply. */
export const MIN_RUNS_FOR_PERCENTILES = 20;

/** The newest runs a population reads. */
export const ESTIMATE_SAMPLE_SIZE = 200;

/** How far back a population reads. */
export const ESTIMATE_WINDOW_MS = 30 * 24 * 60 * 60_000;

/** A run shorter than this is not a measurement (a cache hit, a crash at start). */
export const MIN_RUN_MS = 1_000;

/** The run outcomes that ended with an answer; released, lost, unavailable and failed are not. */
export const ANSWERED_OUTCOMES = ["verified", "no_spec", "needs_clarification", "conflicting_sources", "waiting_manual"] as const;

/**
 * The `p`-th percentile of ascending `sorted` values, interpolated linearly between ranks
 * (PostgreSQL's `percentile_cont`).
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lowValue = sorted[low]!;
  return lowValue + (sorted[high]! - lowValue) * (rank - low);
}

/**
 * The timings of a path from its durations, in seconds.
 *
 * @param durationsS - The population, any order.
 * @returns P25–P90 and P50 with at least twenty durations; the defaults otherwise.
 */
export function timingsFrom(path: EstimatePath, durationsS: readonly number[]): PathTimings {
  if (durationsS.length < MIN_RUNS_FOR_PERCENTILES) {
    return { range: DEFAULT_RUN_RANGES[path], p50S: DEFAULT_SEARCH_P50_S };
  }
  const sorted = [...durationsS].sort((a, b) => a - b);
  return { range: { lowerS: percentile(sorted, 0.25), upperS: percentile(sorted, 0.9) }, p50S: percentile(sorted, 0.5) };
}

/** The queue term, in seconds: ⌈k × P50 / 60 s⌉ whole minutes. */
export function queueTermS(ahead: number, p50S: number): number {
  if (ahead <= 0) return 0;
  return Math.ceil((ahead * p50S) / 60) * 60;
}

/** The stored bounds, seconds from `requested_at`. */
export type StoredEstimate = { minS: number; maxS: number };

/**
 * The bounds to store.
 *
 * @param elapsedS - The time already elapsed since `requested_at` at this moment.
 * @param queueS - The queue term ({@link queueTermS}), 0 at a claim and on entering the wait.
 */
export function storedEstimate(elapsedS: number, queueS: number, range: RunRange): StoredEstimate {
  const base = Math.max(0, elapsedS) + queueS;
  return { minS: Math.round(base + range.lowerS), maxS: Math.round(base + range.upperS) };
}

/** The stored bounds as the contract's whole minutes: X = max(1, ⌊lower⌋), Y = max(X + 1, ⌈upper⌉). */
export function expectedMinutes(estimate: StoredEstimate): { min: number; max: number } {
  const min = Math.max(1, Math.floor(estimate.minS / 60));
  return { min, max: Math.max(min + 1, Math.ceil(estimate.maxS / 60)) };
}

/**
 * Reads a path's population and returns its timings.
 *
 * Only the runs of the research model in force count (switch-oil-research-to-openai D7): a run
 * written before the column existed (NULL) counts as {@link LEGACY_RESEARCH_MODEL_KEY}, so GLM-era
 * durations never set another model's range, and a change of effort starts a new sample.
 *
 * @param now - The window ends here.
 * @param researchModel - The configured research model, `provider:model:effort`.
 */
export async function loadPathTimings(
  tx: DbClient,
  path: EstimatePath,
  now: Date,
  researchModel: string = configuredResearchModelKey(),
): Promise<PathTimings> {
  const since = new Date(now.getTime() - ESTIMATE_WINDOW_MS);
  const answered = [...ANSWERED_OUTCOMES];
  const rows =
    path === "search"
      ? await tx.$queryRaw<{ ms: number }[]>`
          SELECT ms FROM (
            SELECT (EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)::float8 AS ms, finished_at
            FROM oil_research_run
            WHERE path = 'search' AND kind IN ('full', 'refetch')
              AND COALESCE(research_model, ${LEGACY_RESEARCH_MODEL_KEY}) = ${researchModel}
              AND outcome = ANY(${answered}::text[])
              AND finished_at IS NOT NULL AND finished_at >= ${since} AND finished_at <= ${now}
          ) AS runs
          WHERE ms >= ${MIN_RUN_MS}
          ORDER BY finished_at DESC
          LIMIT ${ESTIMATE_SAMPLE_SIZE}`
      : await tx.$queryRaw<{ ms: number }[]>`
          SELECT ms FROM (
            SELECT (EXTRACT(EPOCH FROM ((queued_at - wait_started_at) + (finished_at - started_at))) * 1000)::float8 AS ms, finished_at
            FROM oil_research_run
            WHERE path = 'manual' AND trigger = 'wait_ended'
              AND COALESCE(research_model, ${LEGACY_RESEARCH_MODEL_KEY}) = ${researchModel}
              AND outcome = ANY(${answered}::text[])
              AND wait_started_at IS NOT NULL AND queued_at IS NOT NULL
              AND finished_at IS NOT NULL AND finished_at >= ${since} AND finished_at <= ${now}
          ) AS runs
          WHERE ms >= ${MIN_RUN_MS}
          ORDER BY finished_at DESC
          LIMIT ${ESTIMATE_SAMPLE_SIZE}`;
  return timingsFrom(
    path,
    rows.map((row) => Number(row.ms) / 1000),
  );
}
