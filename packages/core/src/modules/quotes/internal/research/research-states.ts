/**
 * The research row's vocabulary (background-oil-research D7, D8, D10, D12): states, kinds,
 * triggers, priorities, Tecfil states, and the retry schedules. Stored as plain TEXT, so these
 * lists are the only place the values are named.
 */

/** Every state an identity's research row can be in (D10). */
export const RESEARCH_STATES = [
  "queued",
  "running",
  "waiting_manual",
  "verified",
  "no_spec",
  "needs_clarification",
  "conflicting_sources",
  "failed",
  "abandoned",
] as const;
export type ResearchState = (typeof RESEARCH_STATES)[number];

/** The resting states other than `verified`: a new cycle only when D10's re-run policy allows. */
export const RESTING_STATES = ["no_spec", "needs_clarification", "conflicting_sources", "failed", "abandoned"] as const;

/**
 * A research cycle's kind, strongest first: `refetch` > `engine_pick` > `full` > `manual_resolve`
 * (D7). `engine_pick` re-reads the passages a clarification kept, for one engine (D24).
 */
export type ResearchKind = "full" | "refetch" | "manual_resolve" | "engine_pick";

/**
 * Who queued the cycle (D7, D11, D24). `wait_ended` and `adopted` are the runner's own;
 * `engine_pick` is a clarification's engine pick (kind `engine_pick`, or `full` when it kept no passages).
 */
export type ResearchTrigger = "quote_open" | "refetch" | "registration" | "backfill" | "manual_upgrade" | "wait_ended" | "adopted" | "engine_pick";

/** The triggers a caller of the one enqueue may pass. */
export type EnqueueTrigger = "quote_open" | "refetch" | "registration" | "backfill" | "manual_upgrade" | "engine_pick";

/** 0 someone is waiting; 1 a registration or a manual upgrade; 2 the backfill (D8). */
export type ResearchPriority = 0 | 1 | 2;

/** Tecfil's own claim state on a verified row (D12). */
export type TecfilState = "pending" | "running" | "ok" | "unmatched" | "unavailable";

/**
 * The two research paths a run takes, plus Tecfil alone, a manual reading and an engine re-read
 * (D14, D24). Only `search` and `manual` are timing populations.
 */
export type RunPath = "search" | "manual" | "tecfil" | "reading" | "engine_pick";

/** Attempts per research cycle (D10, `OIL_RESEARCH_MAX_ATTEMPTS`). */
export const OIL_RESEARCH_MAX_ATTEMPTS = 3;

/** A transient outage's backoff, one entry fewer than the attempts (D10): 5 min, then 15 min. */
export const RESEARCH_BACKOFF_MS = [5 * 60_000, 15 * 60_000] as const;

/** A Tecfil failure's backoff (D12): 15 min, 1 h, 6 h, then every 24 h. */
export const TECFIL_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000] as const;
export const TECFIL_DAILY_RETRY_MS = 24 * 60 * 60_000;

/** The search-miss window a `no_spec` rests for before a quote-open re-runs it (`WEB_SEARCH_MISS_TTL_HOURS`). */
export const DEFAULT_MISS_TTL_MS = 168 * 60 * 60_000;

/** A `failed` identity is re-run by a quote-open this long after it failed (D10). */
export const FAILED_RERUN_AFTER_MS = 24 * 60 * 60_000;

/** When the next research attempt is due after a transient outage on attempt `attempts`. */
export function researchBackoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), RESEARCH_BACKOFF_MS.length) - 1;
  return RESEARCH_BACKOFF_MS[index]!;
}

/** When the next Tecfil consultation is due after a failure on Tecfil attempt `attempts`. */
export function tecfilBackoffMs(attempts: number): number {
  return attempts <= TECFIL_BACKOFF_MS.length ? TECFIL_BACKOFF_MS[Math.max(attempts, 1) - 1]! : TECFIL_DAILY_RETRY_MS;
}
