/**
 * The report buckets on the São Paulo calendar: which day/week/month bucket an
 * instant belongs to, and whether it falls in a half-open report period.
 *
 * Which local day an instant falls on is the shared kernel's
 * (`shared/sao-paulo-calendar.ts`), because the Serviços period filter has to
 * agree with these buckets; this file only groups those days. Moved from
 * `apps/api/src/reports/aggregate.ts`; `spYmd`/`ymdKey`/`saoPauloDateKey` left
 * for the shared kernel and are called from there, with identical output.
 */
import type { ReportGranularity } from "../contracts/http.js";
import {
  SAO_PAULO_TIME_ZONE,
  calendarDayKey,
  saoPauloCalendarDay,
  type CalendarDay,
} from "../../../shared/index.js";

/** Monday-based day-of-week in São Paulo: Mon=0 … Sun=6 */
function spMondayOffset(date: Date): number {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: SAO_PAULO_TIME_ZONE,
    weekday: "short",
  }).format(date);
  const map: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  return map[weekday] ?? 0;
}

function addDaysUtcApprox(ymd: CalendarDay, delta: number): CalendarDay {
  const utc = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day + delta, 12, 0, 0));
  return saoPauloCalendarDay(utc);
}

/**
 * True when `periodStart <= instant < periodEnd`.
 *
 * @param instant - Timestamp to test (e.g. message or conversation time).
 * @param periodStart - Inclusive start of the report period.
 * @param periodEnd - Exclusive end of the report period.
 * @returns Whether `instant` falls in the half-open interval.
 */
export function inHalfOpenPeriod(instant: Date, periodStart: Date, periodEnd: Date) {
  return instant.getTime() >= periodStart.getTime() && instant.getTime() < periodEnd.getTime();
}

/**
 * Bucket start date string for chart grouping in America/Sao_Paulo.
 *
 * @param firstInboundAt - Conversation first-inbound timestamp used as the bucket anchor.
 * @param granularity - `day`, `week` (Monday start), or `month` grouping.
 * @returns ISO date string (`YYYY-MM-DD`) for the bucket start.
 */
export function bucketKey(firstInboundAt: Date, granularity: ReportGranularity): string {
  const ymd = saoPauloCalendarDay(firstInboundAt);
  if (granularity === "day") {
    return calendarDayKey(ymd);
  }
  if (granularity === "month") {
    return calendarDayKey({ ...ymd, day: 1 });
  }
  const monday = addDaysUtcApprox(ymd, -spMondayOffset(firstInboundAt));
  return calendarDayKey(monday);
}
