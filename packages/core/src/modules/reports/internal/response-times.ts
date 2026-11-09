/**
 * Response-time statistics for the report: median, nearest-rank p90, and the
 * mean/median/p90/count summaries built from them, plus the answered/total
 * coverage pair. Pure; durations are milliseconds.
 *
 * Moved from `apps/api/src/reports/aggregate.ts`, unchanged.
 */
import type { FirstResponseStats, ReportCoverage, SubsequentResponseStats } from "../contracts/http.js";

/**
 * Median of a non-empty ascending-sorted duration array in milliseconds.
 *
 * @param sorted - Durations sorted ascending; must be non-empty for a numeric result.
 * @returns Median duration in ms, or `null` when `sorted` is empty.
 */
export function medianMs(sorted: number[]) {
  if (sorted.length === 0) {
    return null;
  }
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Nearest-rank p90 on a non-empty ascending sorted array.
 *
 * @param sorted - Durations sorted ascending; must be non-empty for a numeric result.
 * @returns 90th-percentile duration in ms, or `null` when `sorted` is empty.
 */
export function p90Ms(sorted: number[]) {
  if (sorted.length === 0) {
    return null;
  }
  const rank = Math.ceil(0.9 * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

/**
 * Mean, median, p90, and eligible count for first-reply durations.
 *
 * @param durationsMs - First-response durations in milliseconds (may be unsorted).
 * @returns {@link FirstResponseStats}; all time fields are `null` when no durations are provided.
 */
export function firstResponseStats(durationsMs: number[]): FirstResponseStats {
  if (durationsMs.length === 0) {
    return { meanMs: null, medianMs: null, p90Ms: null, eligibleCount: 0 };
  }
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  return {
    meanMs: sum / sorted.length,
    medianMs: medianMs(sorted),
    p90Ms: p90Ms(sorted),
    eligibleCount: sorted.length,
  };
}

/**
 * Extends {@link firstResponseStats} with total inbound message count for subsequent replies.
 *
 * @param durationsMs - Subsequent-response durations in milliseconds.
 * @param inboundTotal - Count of inbound messages used as the denominator for coverage.
 * @returns {@link SubsequentResponseStats} with `inboundTotal` attached.
 */
export function subsequentResponseStats(
  durationsMs: number[],
  inboundTotal: number,
): SubsequentResponseStats {
  return { ...firstResponseStats(durationsMs), inboundTotal };
}

/**
 * Simple answered/total pair for coverage percentages.
 *
 * @param answered - Count of conversations or messages that received a reply.
 * @param total - Total eligible conversations or messages in the denominator.
 * @returns {@link ReportCoverage} pair used in report DTOs.
 */
export function coverageOf(answered: number, total: number): ReportCoverage {
  return { answered, total };
}
