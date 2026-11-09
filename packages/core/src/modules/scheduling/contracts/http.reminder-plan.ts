/**
 * What confirming a return's reminder message should write: one scheduled
 * message per trigger, each with its own send instant and its own resolved text.
 *
 * Pure, like {@link planVehicleReturns}. It reads no clock beyond the `now` it
 * is handed and touches no database; the demo seed (`packages/core/prisma/seed`) applies what it returns.
 *
 * The reason each row freezes its own text rather than sharing one: elapsed time
 * is measured to that row's own send moment. A reminder going out a month early
 * must not claim the full interval has passed, so "five months" and "six months"
 * are two different strings on two rows of the same message.
 *
 * `returnDate` is taken as `YYYY-MM-DD` rather than a `Date` on purpose. The
 * column is a `@db.Date`, which Prisma hands back as UTC midnight, and reading
 * that instant's São Paulo calendar day yields the day BEFORE — the return is
 * a calendar day, so it travels as one.
 *
 * Moved from `packages/shared-types/src/reminder-plan.ts` (5.1d) with declarations unchanged.
 */

/** IANA zone every send moment below is resolved in. */
const TIME_ZONE = "America/Sao_Paulo";

/**
 * The Portuguese text a reminder opens pre-filled with.
 *
 * Placeholders follow the house `{{snake_case}}` convention already used by
 * response templates. The sentence names the service without an article
 * ("o último serviço de troca de óleo") so no gender agreement has to be
 * guessed from the service name.
 */
export const DEFAULT_REMINDER_TEMPLATE =
  "Faz {{tempo_decorrido}} desde o último serviço de {{servico}} no seu {{veiculo}}. " +
  "O tempo recomendado entre cada {{servico}} é de {{intervalo}}.";

/**
 * São Paulo wall-clock time an offset reminder is sent at unless changed.
 *
 * Mid-morning on purpose: a reminder that arrives at 09:00 reads as the shop
 * getting in touch, where one timed to midnight reads as an automated blast.
 *
 * This is what a NEWLY ADDED send moment opens filled in with; the attendant may
 * change that moment's hour before confirming, and each moment keeps its own.
 * A starting point rather than policy — every trigger carries its own `time`,
 * so nothing is ever sent at an hour the attendant was never shown.
 */
export const DEFAULT_REMINDER_SEND_TIME = { hour: 9, minute: 0 } as const;

/**
 * One send moment on a reminder message.
 *
 * `before` and `after` are offsets from the return date and move when it is
 * edited; `absolute` is the attendant naming an exact day, which a later edit
 * MUST NOT override. The approved design draws all three — "30 dias antes",
 * "no dia" (which is `before` with 0 days), and "7 dias depois".
 *
 * Two kinds rather than one signed number on purpose: the storage column packs
 * the direction into the sign of `leadDays`, and a caller who has only that
 * column's doc comment cannot tell whether a negative is legal or a bug.
 */
export type ReminderTrigger =
  | { kind: "before"; days: number; time: { hour: number; minute: number } }
  | { kind: "after"; days: number; time: { hour: number; minute: number } }
  | { kind: "absolute"; at: Date };

/**
 * The stored offset for one offset trigger: positive before the return date,
 * negative after it.
 *
 * This is the ONLY place the sign convention is applied, so the wire never
 * carries it and no caller has to know it exists.
 *
 * @throws When `days` is not a non-negative integer, which would express a
 *   direction twice — once in the kind and once in the sign — and the two
 *   could disagree.
 */
function leadDaysOf(trigger: { kind: "before" | "after"; days: number }): number {
  if (!Number.isInteger(trigger.days) || trigger.days < 0) {
    throw new Error(`trigger days must be a non-negative integer, got ${trigger.days}`);
  }
  return trigger.kind === "before" ? trigger.days : -trigger.days;
}

/** One scheduled message to write, already resolved for its own moment. */
export type PlannedReminderRow = {
  scheduledAt: Date;
  /**
   * Offset from the return date: POSITIVE is days before it, NEGATIVE is days
   * after it, null when the attendant named an absolute date. The sign is the
   * `before`/`after` trigger kind packed into one column; nothing outside this
   * module and the database should have to know that.
   */
  leadDays: number | null;
  frozenText: string;
};

/** Either the rows to write, or the reason nothing should be written. */
export type PlanReminderResult =
  | { status: "ok"; rows: PlannedReminderRow[] }
  | { status: "no_triggers" }
  | { status: "trigger_in_past"; at: Date }
  | { status: "duplicate_trigger"; at: Date };

type Ymd = { year: number; month: number; day: number };

type Wall = Ymd & { hour: number; minute: number };

function wallClockInZone(instant: Date): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

/**
 * The instant at which a São Paulo wall clock reads the given day and time.
 *
 * Corrects a naive UTC guess by the gap between the wall time it actually
 * produces and the one asked for. Two passes rather than one so a day on which
 * the offset itself changes still converges.
 */
function instantInZone(day: Ymd, hour: number, minute: number): Date {
  const target = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
  let utc = target;
  for (let pass = 0; pass < 2; pass += 1) {
    const local = wallClockInZone(new Date(utc));
    const got = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    if (got === target) {
      break;
    }
    utc += target - got;
  }
  return new Date(utc);
}

function parseDay(value: string): Ymd {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`returnDate must be YYYY-MM-DD, got ${value}`);
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function addDays(day: Ymd, amount: number): Ymd {
  const utc = new Date(Date.UTC(day.year, day.month - 1, day.day + amount));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function pluralUnit(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * How long has passed between two instants, in Portuguese.
 *
 * Whole completed months, with the leftover days dropped: a reminder sent early
 * always understates the elapsed time rather than overstating it, which is the
 * property that keeps "faz 6 meses" honest on a message going out a week early.
 * Falls back to days below one month, where months would render as zero.
 *
 * @param from - When the service was performed.
 * @param to - The moment this particular reminder is sent.
 * @returns "6 meses", "1 mês", or "12 dias".
 */
function elapsedText(from: Date, to: Date): string {
  const start = wallClockInZone(from);
  const end = wallClockInZone(to);
  let months = (end.year - start.year) * 12 + (end.month - start.month);
  if (end.day < start.day) {
    months -= 1;
  }
  if (months >= 1) {
    return pluralUnit(months, "mês", "meses");
  }
  const startDay = Date.UTC(start.year, start.month - 1, start.day);
  const endDay = Date.UTC(end.year, end.month - 1, end.day);
  return pluralUnit(Math.max(0, Math.round((endDay - startDay) / 86_400_000)), "dia", "dias");
}

/**
 * The recommended interval between two services of this kind, in Portuguese.
 *
 * @param interval - Amount and unit as the interval rule states them.
 * @returns "6 meses", "1 mês", "180 dias", or "1 dia".
 */
function intervalText(interval: { amount: number; unit: "days" | "months" }): string {
  return interval.unit === "months"
    ? pluralUnit(interval.amount, "mês", "meses")
    : pluralUnit(interval.amount, "dia", "dias");
}

/**
 * Substitutes the reminder placeholders, leaving any token it does not know.
 *
 * Unknown tokens survive rather than becoming blanks, matching how response
 * templates already behave: a visible `{{...}}` is a fixable mistake, an empty
 * gap in a sent message is not.
 */
function resolve(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [token, value] of Object.entries(values)) {
    out = out.replaceAll(`{{${token}}}`, value);
  }
  return out;
}

/**
 * Resolves a reminder's text for one send moment.
 *
 * Exported because an edit that changes only the wording has to re-resolve
 * every un-sent row WITHOUT moving it, which neither planning nor replanning
 * expresses: both of those decide an instant as well.
 *
 * @param input.bodyTemplate - The body as the attendant left it.
 * @param input.performedAt - When the qualifying service was performed.
 * @param input.sendAt - The moment this row will go out; elapsed time is
 *   measured to it, not to now.
 * @param input.serviceLabel - The service as it should read in the text.
 * @param input.vehicleLabel - The vehicle as it should read in the text.
 * @param input.interval - The recommended interval between services of this kind.
 * @returns The resolved text, with any token this does not know left visible.
 */
export function resolveReminderText(input: {
  bodyTemplate: string;
  performedAt: Date;
  sendAt: Date;
  serviceLabel: string;
  vehicleLabel: string;
  interval: { amount: number; unit: "days" | "months" };
}): string {
  return resolve(input.bodyTemplate, {
    tempo_decorrido: elapsedText(input.performedAt, input.sendAt),
    servico: input.serviceLabel,
    veiculo: input.vehicleLabel,
    intervalo: intervalText(input.interval),
  });
}

/** What a return-date edit should do to one existing scheduled reminder. */
export type ReplannedReminderRow =
  | { status: "move"; scheduledAt: Date; frozenText: string }
  | { status: "cancel"; scheduledAt: Date; reason: string }
  | { status: "keep" };

/**
 * Recomputes one existing reminder row after its return's date moved.
 *
 * An offset trigger follows the return date; an absolute one does not, because
 * an absolute date is the attendant saying "this exact day" and the system must
 * not override it. The row's own time of day is preserved — the attendant chose
 * that hour, and only the day is being moved.
 *
 * @param input.returnDate - The NEW stored day, `YYYY-MM-DD` in São Paulo.
 * @param input.leadDays - The row's stored offset: positive is days before the
 *   return date, negative is days after it, null when it names an absolute date.
 * @param input.currentScheduledAt - Where the row sits now; its time of day is kept.
 * @param input.performedAt - The service instant elapsed time is measured from.
 * @param input.serviceLabel - The service as it reads in the text.
 * @param input.vehicleLabel - The vehicle as it reads in the text.
 * @param input.interval - The recommended interval between services of this kind.
 * @param input.bodyTemplate - The message's unresolved body.
 * @param input.now - Instant a recomputed moment must still be after.
 * @returns `keep` for an absolute trigger; `move` with the new instant and
 *   re-resolved text; or `cancel` when the recompute lands in the past, which
 *   MUST NOT be dispatched late nor moved silently to the present.
 */
export function replanReminderRow(input: {
  returnDate: string;
  leadDays: number | null;
  currentScheduledAt: Date;
  performedAt: Date;
  serviceLabel: string;
  vehicleLabel: string;
  interval: { amount: number; unit: "days" | "months" };
  bodyTemplate: string;
  now: Date;
}): ReplannedReminderRow {
  if (input.leadDays === null) {
    return { status: "keep" };
  }

  const at = wallClockInZone(input.currentScheduledAt);
  const scheduledAt = instantInZone(
    addDays(parseDay(input.returnDate), -input.leadDays),
    at.hour,
    at.minute,
  );

  if (scheduledAt.getTime() <= input.now.getTime()) {
    return {
      status: "cancel",
      scheduledAt,
      reason: "A nova data de retorno colocaria este lembrete no passado.",
    };
  }

  return {
    status: "move",
    scheduledAt,
    frozenText: resolveReminderText({ ...input, sendAt: scheduledAt }),
  };
}

/**
 * Works out the rows one reminder message should materialise.
 *
 * @param input.returnDate - The return's stored day, `YYYY-MM-DD` in São Paulo.
 *   Authoritative: never recomputed from the service here.
 * @param input.performedAt - When the qualifying service was performed, which
 *   every row's elapsed time is measured from.
 * @param input.serviceLabel - The service as it should read in the text.
 * @param input.vehicleLabel - The vehicle as it should read in the text.
 * @param input.interval - The recommended interval between services of this kind.
 * @param input.bodyTemplate - The body as the attendant left it, placeholders
 *   unresolved. Pass {@link DEFAULT_REMINDER_TEMPLATE} when they made no edit.
 * @param input.triggers - Send moments. At least one, or the plan is rejected.
 * @param input.now - Confirm time, which a trigger must be strictly after.
 * @returns The rows to write, or why none should be: `no_triggers` for a message
 *   nobody would ever send, `trigger_in_past` for a moment already gone, and
 *   `duplicate_trigger` when two triggers land on the same instant, which the
 *   partial unique index on `(return_reminder_message_id, scheduled_at)` would
 *   otherwise reject with an error no attendant could act on.
 */
export function planReminderMessage(input: {
  returnDate: string;
  performedAt: Date;
  serviceLabel: string;
  vehicleLabel: string;
  interval: { amount: number; unit: "days" | "months" };
  bodyTemplate: string;
  triggers: ReminderTrigger[];
  now: Date;
}): PlanReminderResult {
  // A message nobody will ever send is not a plan.
  if (input.triggers.length === 0) {
    return { status: "no_triggers" };
  }

  const due = parseDay(input.returnDate);
  const rows: PlannedReminderRow[] = [];
  const seen = new Set<number>();

  for (const trigger of input.triggers) {
    // Each moment carries its own hour: the attendant may want a month-early
    // nudge at 09:00 and the on-the-day one at 14:00, and the overlay edits
    // them one row at a time.
    const leadDays = trigger.kind === "absolute" ? null : leadDaysOf(trigger);
    const scheduledAt =
      trigger.kind === "absolute"
        ? trigger.at
        : instantInZone(
            // Subtracting the signed offset moves backwards for `before` and
            // forwards for `after`, so one expression covers both directions.
            addDays(due, -leadDaysOf(trigger)),
            trigger.time.hour,
            trigger.time.minute,
          );

    if (scheduledAt.getTime() <= input.now.getTime()) {
      return { status: "trigger_in_past", at: scheduledAt };
    }
    if (seen.has(scheduledAt.getTime())) {
      return { status: "duplicate_trigger", at: scheduledAt };
    }
    seen.add(scheduledAt.getTime());

    rows.push({
      scheduledAt,
      leadDays,
      // Measured to THIS row's moment, which is the whole reason each row
      // carries its own copy of the text.
      frozenText: resolveReminderText({ ...input, sendAt: scheduledAt }),
    });
  }

  rows.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  return { status: "ok", rows };
}
