/**
 * Where a stored vehicle return's date falls relative to today, and the two days
 * that decide it.
 *
 * ONE copy, read by two screens. Follow-up's return sections (`apps/api`'s
 * `follow-up`) and the Serviços return-state filter (`list-unit-services`) both
 * classify through these two functions, because the spec requires a vehicle
 * counted overdue on Follow-up and a vehicle matched by the filter to be the same
 * vehicle. Moved here unchanged from `apps/api/src/follow-up/return-sections.ts`
 * (`classifyReturnDate`) and `follow-up/aggregate.ts` (`followUpReturnWindow` and
 * its three helpers) in adopt-modular-vertical-slices 3C: they classify a
 * `vehicle_return` date, `services`' table, and a module may not import `apps/api`.
 */
import { SCHEDULE_TIME_ZONE } from "./http.return-due.js";

/** Where a stored return date falls relative to today. */
export type ReturnState = "vencido" | "aproximando";

/**
 * Classifies one stored return date.
 *
 * Exported so the Serviços return-state filter classifies through THIS function
 * rather than repeating the two comparisons. The spec requires a vehicle counted
 * overdue on Follow-up and a vehicle matched by that filter to be the same
 * vehicle, and two copies of a boundary is how that quietly stops being true.
 *
 * @param returnDate - The stored day, `YYYY-MM-DD` in America/Sao_Paulo.
 * @param today - Today's calendar day in the same zone and format.
 * @param horizon - Last day counted as approaching, normally today + 14.
 * @returns `"vencido"` once the day has passed, `"aproximando"` from today
 *   through the horizon inclusive, and null beyond it. Today itself is
 *   approaching, not late: the day has not finished.
 */
export function classifyReturnDate(
  returnDate: string,
  today: string,
  horizon: string,
): ReturnState | null {
  if (returnDate < today) {
    return "vencido";
  }
  return returnDate <= horizon ? "aproximando" : null;
}

type Ymd = { year: number; month: number; day: number };

function ymdInZone(instant: Date): Ymd {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SCHEDULE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

/**
 * The two calendar days the return sections are classified against.
 *
 * Exported so the Serviços return-state filter derives its window from HERE
 * rather than repeating the +14 and the zone conversion. Two copies of this is
 * the other half of how a vehicle ends up overdue on one screen and not the
 * other — `classifyReturnDate` covers the comparison, this covers the dates fed
 * into it.
 *
 * @param now - The clock.
 * @returns Today and the last day counted as approaching, both `YYYY-MM-DD` in
 *   America/Sao_Paulo.
 */
export function followUpReturnWindow(now: Date): { today: string; horizon: string } {
  const ymd = ymdInZone(now);
  return { today: ymdText(ymd), horizon: addDaysText(ymd, 14) };
}

function ymdText(ymd: Ymd) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${ymd.year}-${pad(ymd.month)}-${pad(ymd.day)}`;
}

function addDaysText(ymd: Ymd, days: number) {
  const utc = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day + days));
  return ymdText({
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  });
}
