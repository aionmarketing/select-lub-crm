/**
 * The São Paulo calendar: which local day an instant falls on.
 *
 * Every figure the CRM counts by day — the Relatórios buckets, the Serviços
 * period filter — is counted on the America/Sao_Paulo calendar, not UTC: a
 * service at 21:00 BRT belongs to that day, not to the next one. Two copies of
 * this arithmetic would drift apart, and the funnel and the services list would
 * then disagree about which day a service happened on. That is why it is shared
 * kernel rather than a function one module lends another.
 *
 * Moved from `apps/api/src/reports/aggregate.ts` (`spYmd`, `ymdKey`,
 * `saoPauloDateKey`), where the services store had been importing it across
 * feature lines.
 */

/** The IANA zone every day-level figure is counted in. */
export const SAO_PAULO_TIME_ZONE = "America/Sao_Paulo";

/** A calendar day. `month` is 1-based. */
export type CalendarDay = { year: number; month: number; day: number };

/**
 * The São Paulo calendar day an instant falls on.
 *
 * @param instant - Any instant.
 * @returns Its local year, 1-based month and day in America/Sao_Paulo.
 */
export function saoPauloCalendarDay(instant: Date): CalendarDay {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SAO_PAULO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);
  return { year, month, day };
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

/**
 * Writes a calendar day as `YYYY-MM-DD`.
 *
 * @param day - The day to write.
 * @returns Its ISO date string, zero-padded.
 */
export function calendarDayKey(day: CalendarDay): string {
  return `${day.year}-${pad2(day.month)}-${pad2(day.day)}`;
}

/**
 * Calendar day an instant falls on in America/Sao_Paulo, as `YYYY-MM-DD`.
 *
 * The Serviços period filter bounds dates with this so they agree with the
 * report buckets.
 *
 * @param instant - Instant to place on the São Paulo calendar.
 * @returns `YYYY-MM-DD` for that instant's local day.
 */
export function saoPauloDateKey(instant: Date): string {
  return calendarDayKey(saoPauloCalendarDay(instant));
}
