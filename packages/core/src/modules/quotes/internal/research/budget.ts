/**
 * The daily budget (background-oil-research D8, D13; `oil-research` "The backfill stops at the
 * daily budget").
 *
 * - A day is America/Sao_Paulo's calendar day: a run at 02:59:59Z counts toward the previous
 *   local day, one at 03:00:00Z toward the new one.
 * - The day's spend is the sum of `cost_usd` of every run row whose `started_at` falls in it:
 *   research runs and manual readings, attended and backfill alike, released and lost runs
 *   included. The Tecfil picker's cost is a column of its own, outside the cap (owner).
 * - Only the backfill is capped: at or above the budget, no priority-2 claim that spends is
 *   made; a priority-2 Tecfil-only claim still is, and priority 0 and 1 are claimed as usual. A
 *   budget of 0 is valid and holds only the backfill.
 */
import type { DbClient } from "@select-lub/core/db";

/** The time zone the day turns in. */
export const BUDGET_TIME_ZONE = "America/Sao_Paulo";

/** The default daily budget, USD (owner, 2026-10-11: raised from 1; it still holds only the backfill). */
export const DEFAULT_DAILY_BUDGET_USD = 2;

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: BUDGET_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const offsetFormat = new Intl.DateTimeFormat("en-US", { timeZone: BUDGET_TIME_ZONE, timeZoneName: "longOffset" });

/** The local calendar day of `at`, `YYYY-MM-DD`. */
export function saoPauloDay(at: Date): string {
  return dayFormat.format(at);
}

/** The zone's UTC offset at `at`, in minutes (−180 for UTC−3). */
function offsetMinutes(at: Date): number {
  const name = offsetFormat.formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/** The instant a local day (`YYYY-MM-DD`) starts. */
function localMidnight(day: string): Date {
  const utcMidnight = new Date(`${day}T00:00:00.000Z`);
  // The offset in force at that local midnight; one correction pass covers a DST boundary.
  const guess = new Date(utcMidnight.getTime() - offsetMinutes(utcMidnight) * 60_000);
  return new Date(utcMidnight.getTime() - offsetMinutes(guess) * 60_000);
}

/** The local day of `at`, as `[start, end)` instants. */
export function saoPauloDayBounds(at: Date): { day: string; start: Date; end: Date } {
  const day = saoPauloDay(at);
  const start = localMidnight(day);
  // A day is at most 25 h long; the next local day's midnight ends this one.
  const end = localMidnight(saoPauloDay(new Date(start.getTime() + 26 * 60 * 60_000)));
  return { day, start, end };
}

/** The next local midnight after `at`: when a budget pause ends. */
export function nextSaoPauloMidnight(at: Date): Date {
  return saoPauloDayBounds(at).end;
}

/**
 * The day's spend: `cost_usd` of every run row started in `now`'s local day.
 *
 * @returns USD.
 */
export async function daySpendUsd(tx: DbClient, now: Date): Promise<number> {
  const { start, end } = saoPauloDayBounds(now);
  const rows = await tx.$queryRaw<{ total: string | null }[]>`
    SELECT SUM(cost_usd)::text AS total FROM oil_research_run
    WHERE started_at >= ${start} AND started_at < ${end}`;
  return Number(rows[0]?.total ?? 0);
}

/**
 * Whether the backfill is held by the budget.
 *
 * @returns True when the day's spend is at or above the budget; a budget of 0 always holds it.
 */
export function budgetReached(spendUsd: number, budgetUsd: number): boolean {
  return spendUsd >= budgetUsd;
}
