/**
 * When a vehicle is due back: date math from a service `performedAt` and the
 * interval rules, in America/Sao_Paulo.
 *
 * Lives here rather than in `apps/api` because three callers in two apps need
 * the same answer and a second implementation would drift: the API's scheduled
 * stores suggest a Programar mensagem date from it, the worker's Omie import
 * uses it to date a new `VehicleReturn`, and Relatorios' churn snapshot uses it
 * to decide whether a customer has lapsed. `apps/worker` cannot import from
 * `apps/api`, which is what forced the move.
 *
 * Note what this does NOT decide: once a return exists, its stored `returnDate`
 * is authoritative and editable per vehicle. This computes the INITIAL date
 * only — recomputing it on read is what made an edited date impossible.
 *
 * Moved from `packages/shared-types/src/return-due.ts` (5.1d) with declarations unchanged.
 */

/** IANA timezone for all schedule suggestions and midnight anchoring. */
export const SCHEDULE_TIME_ZONE = "America/Sao_Paulo";

/** Interval rule row shape loaded from Postgres or seeded in memory tests. */
export type IntervalRuleInput = {
  id: string;
  version: number;
  criterion: string;
  criterionId: string | null;
  intervalAmount: number;
  intervalUnit: "days" | "months";
  priority: number;
  active: boolean;
  validFrom: Date | null;
  validTo: Date | null;
};

/** Winner rule metadata plus the suggested follow-up instant. */
export type SuggestDateResult = {
  suggestedAt: Date;
  suggestionSource: "rule" | "six_months";
  intervalRuleId: string | null;
  intervalRuleVersion: number | null;
};

type Ymd = { year: number; month: number; day: number };

function ymdInZone(instant: Date, timeZone: string): Ymd {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function addCalendar(ymd: Ymd, amount: number, unit: "days" | "months"): Ymd {
  const utc =
    unit === "days"
      ? new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day + amount))
      : new Date(Date.UTC(ymd.year, ymd.month - 1 + amount, ymd.day));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function midnightInZone(ymd: Ymd, timeZone: string): Date {
  for (let hour = 0; hour < 12; hour += 1) {
    const candidate = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day, hour, 0, 0));
    const local = ymdInZone(candidate, timeZone);
    const localHour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(candidate),
    );
    if (local.year === ymd.year && local.month === ymd.month && local.day === ymd.day && localHour === 0) {
      return candidate;
    }
  }
  return new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day, 3, 0, 0));
}

function ruleMatches(rule: IntervalRuleInput, kind: string | null, at: Date) {
  if (!rule.active) {
    return false;
  }
  if (rule.validFrom && at < rule.validFrom) {
    return false;
  }
  if (rule.validTo && at > rule.validTo) {
    return false;
  }
  if (rule.criterionId == null || rule.criterionId === "") {
    return true;
  }
  return rule.criterionId === kind;
}

/**
 * Picks the matching active rule only when exactly one matches, or a six-month default.
 *
 * @param input - Service `performedAt` instant, service `kind` string, and interval rules.
 * @returns Suggested follow-up midnight in {@link SCHEDULE_TIME_ZONE} plus winning rule metadata.
 */
export function suggestDate(input: {
  performedAt: Date;
  kind: string | null;
  rules: IntervalRuleInput[];
}): SuggestDateResult {
  const matching = input.rules.filter((rule) => ruleMatches(rule, input.kind, input.performedAt));
  const start = ymdInZone(input.performedAt, SCHEDULE_TIME_ZONE);
  if (matching.length !== 1) {
    return {
      suggestedAt: midnightInZone(addCalendar(start, 6, "months"), SCHEDULE_TIME_ZONE),
      suggestionSource: "six_months",
      intervalRuleId: null,
      intervalRuleVersion: null,
    };
  }
  const winner = matching[0];
  const unit = winner.intervalUnit === "days" ? "days" : "months";
  return {
    suggestedAt: midnightInZone(addCalendar(start, winner.intervalAmount, unit), SCHEDULE_TIME_ZONE),
    suggestionSource: "rule",
    intervalRuleId: winner.id,
    intervalRuleVersion: winner.version,
  };
}
