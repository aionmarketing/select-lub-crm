/**
 * Test design (testing-strategy)
 *
 * SUT: planReminderMessage and replanReminderRow — both pure. No clock, no
 * database: `now`, the return day, the service instant and the send time of day
 * are all arguments.
 *
 * Oracle: vehicle-returns (align-shipped-ui-to-revised-canvas delta) —
 *   "Confirming SHALL create one scheduled message per trigger, each with its own
 *   send instant and its own resolved text"; "A reminder message with no triggers
 *   SHALL be rejected: a message nobody will ever send is not a plan"; "A trigger
 *   that resolves to an instant already past at confirm time SHALL be rejected";
 *   "The elapsed time SHALL be measured to that trigger's own send moment, not to
 *   the moment of confirming, so a reminder sent a month early does not claim the
 *   full interval has passed"; scenario "one message has triggers 30 days before
 *   and on a return date six months after the service THEN the earlier reminder's
 *   text states five months elapsed and the later one states six"; "The default
 *   text names the elapsed time, the service, the vehicle, and the recommended
 *   interval". Elapsed time renders as whole months rounded down (decided
 *   2026-09-03; the spec pins only the two whole-month cases).
 *
 * Axes
 *   A1 trigger count — zero / one / three
 *   A2 trigger kind — lead / absolute / both on one message
 *   A3 scheduledAt vs now — after / equal / before. Ordered, so BVA on the
 *      rejection boundary: now+1ms, now, now−1ms
 *   A4 elapsed months vs the day-of-month boundary — the send day before, on,
 *      and after the service's day of month (which is where the month count
 *      decrements)
 *   A5 elapsed below one month — falls back to days
 *   A6 interval unit — months / days
 *   A7 template — the default / an attendant edit / an unknown token
 *   A8 two triggers on the same instant — via two leads / a lead and an absolute
 *   A9 (replan) leadDays — an offset / null (absolute)
 *   A10 (replan) recomputed instant vs now — ahead / already passed
 *   A11 (replan) direction of the move — later / earlier
 *
 * Outputs
 *   O1 status ok with one row per trigger
 *   O2 rows ordered by send instant
 *   O3 leadDays: the offset on a lead, null on an absolute
 *   O4 per-row frozenText, differing between rows of one message
 *   O5 status no_triggers
 *   O6 status trigger_in_past, carrying the offending instant
 *   O7 status duplicate_trigger
 *   O8 the four values present in the default text
 *   O9 (replan) keep, for an absolute trigger
 *   O10 (replan) move, with a new instant, the row's own hour, and new text
 *   O11 (replan) cancel, carrying a Portuguese reason
 *
 * Sampled-cell
 *   three triggers, mixed kinds   | A1 A2 A3 | O1 O2 O3 O4 | a shared text, or lost ordering
 *   the spec's five-vs-six case   | A4       | O4          | both rows claiming six months
 *   day-of-month boundary         | A4 BVA   | O4          | 5 months read as 6 the day before
 *   under a month                 | A5       | O4          | "0 meses"
 *   empty trigger list            | A1 zero  | O5          | an empty ok with no rows
 *   past and exactly-now triggers | A3 BVA   | O6          | now accepted, or now+1ms rejected
 *   duplicate instants            | A8       | O7          | two rows the unique index rejects
 *   default text and an edit      | A6 A7    | O8 O4       | a token surviving, or a blank gap
 *   offset follows a later date   | A9 A10 A11 | O10       | the hour drifting, or stale text
 *   absolute stays put            | A9 null  | O9          | an explicit date overridden
 *   recompute into the past       | A10 past | O11         | dispatched late, or moved to now
 *
 * Decision / branch map (reminder-plan.ts)
 *   triggers.length === 0        T empty-list it; F every other it
 *   trigger.kind === "lead"      T lead its; F absolute its (both in the mixed it)
 *   scheduledAt <= now           T past/equal its; F accepted its
 *   seen.has(...)                T duplicate it; F every other it
 *   months >= 1                  T month its; F under-a-month it
 *   end.day < start.day          T boundary it (day before); F boundary it (day on/after)
 *   interval.unit === "months"   T default-text it; F days-interval it
 *   count === 1 (pluralUnit)     T "1 mês" in the under-a-month it; F "6 meses"
 *   parseDay regex miss          T malformed-day it; F every other it
 *   leadDays === null (replan)   T absolute-stays it; F the two move/cancel its
 *   recomputed <= now (replan)   T cancel it; F move it
 *   instantInZone convergence    contract-hidden: São Paulo has had a fixed
 *     UTC−3 offset since 2019, so the correction converges on the first pass and
 *     the second is a guard with no input in this zone that exercises it
 *
 * Out of scope: writing the rows (the demo seed applies the plan); the CONNECTED
 *   block and the outbox key, which belong to the scheduled-message path already
 *   under test; cascading a returnDate edit onto these rows (task 11.1d).
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_REMINDER_TEMPLATE, planReminderMessage, replanReminderRow, type ReminderTrigger } from "./http.reminder-plan.js";

/** Service performed 10/03/2026, so the six-month return lands on 10/09/2026. */
const PERFORMED_AT = new Date("2026-03-10T14:00:00.000Z");
const RETURN_DATE = "2026-09-10";
const NOW = new Date("2026-03-11T12:00:00.000Z");

function plan(over: Partial<Parameters<typeof planReminderMessage>[0]> = {}) {
  return planReminderMessage({
    returnDate: RETURN_DATE,
    performedAt: PERFORMED_AT,
    serviceLabel: "troca de óleo",
    vehicleLabel: "Toyota Corolla",
    interval: { amount: 6, unit: "months" },
    bodyTemplate: DEFAULT_REMINDER_TEMPLATE,
    triggers: [{ kind: "before", days: 0, time: { hour: 9, minute: 0 } }],
    now: NOW,
    ...over,
  });
}

/** São Paulo has been a fixed UTC−3 since 2019, so 09:00 local is 12:00Z. */
function saoPaulo9am(day: string) {
  return new Date(`${day}T12:00:00.000Z`);
}

describe("planReminderMessage", () => {
  it("makes one row per trigger, ordered by send instant, mixing lead and absolute", () => {
    const triggers: ReminderTrigger[] = [
      { kind: "before", days: 0, time: { hour: 9, minute: 0 } },
      { kind: "absolute", at: new Date("2026-06-01T13:30:00.000Z") },
      { kind: "before", days: 30, time: { hour: 9, minute: 0 } },
    ];

    const result = plan({ triggers });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    expect(result.rows).toHaveLength(3);
    // Given out of order, returned in the order they will fire.
    expect(result.rows.map((row) => row.scheduledAt.toISOString())).toEqual([
      "2026-06-01T13:30:00.000Z",
      saoPaulo9am("2026-08-11").toISOString(),
      saoPaulo9am("2026-09-10").toISOString(),
    ]);
    // An absolute trigger carries no offset, so a later date edit cannot move it.
    expect(result.rows.map((row) => row.leadDays)).toEqual([null, 30, 0]);
    // Three moments, three texts — not one shared string.
    expect(new Set(result.rows.map((row) => row.frozenText)).size).toBe(3);
  });

  it("states five months a month early and six on the day", () => {
    const result = plan({
      triggers: [
        { kind: "before", days: 30, time: { hour: 9, minute: 0 } },
        { kind: "before", days: 0, time: { hour: 9, minute: 0 } },
      ],
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    expect(result.rows[0]?.frozenText).toContain("Faz 5 meses");
    expect(result.rows[1]?.frozenText).toContain("Faz 6 meses");
  });

  it("counts a month only once its day of the month has arrived", () => {
    // The service was performed on the 10th, so 09/09 is five months and 10/09
    // is six. One day either side of that boundary, and the boundary itself.
    const texts = ([1, 0] as const).map((days) => {
      const result = plan({ triggers: [{ kind: "before", days, time: { hour: 9, minute: 0 } }] });
      return result.status === "ok" ? (result.rows[0]?.frozenText ?? "") : result.status;
    });

    expect(texts[0]).toContain("Faz 5 meses");
    expect(texts[1]).toContain("Faz 6 meses");

    // The day after the boundary is still six months, not seven. This is the
    // "7 dias depois" shape the approved design draws — expressible as its own
    // kind now, where it used to need a negative offset nobody documented.
    const after = plan({ triggers: [{ kind: "after", days: 1, time: { hour: 9, minute: 0 } }] });
    expect(after.status === "ok" ? after.rows[0]?.frozenText : "").toContain("Faz 6 meses");
  });

  it("puts an after-trigger past the return date and carries the sign into leadDays", () => {
    const result = plan({
      triggers: [
        { kind: "before", days: 30, time: { hour: 9, minute: 0 } },
        { kind: "after", days: 7, time: { hour: 9, minute: 0 } },
      ],
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    // Return date is 10/09, so "7 dias depois" is 17/09 — after it, not before.
    expect(result.rows.map((row) => row.scheduledAt.toISOString())).toEqual([
      saoPaulo9am("2026-08-11").toISOString(),
      saoPaulo9am("2026-09-17").toISOString(),
    ]);
    // The direction lives in the sign of the stored column and nowhere else.
    expect(result.rows.map((row) => row.leadDays)).toEqual([30, -7]);
  });

  it("gives each moment of one message its own hour", () => {
    const result = plan({
      triggers: [
        // A month-early nudge in the morning, the on-the-day one after lunch.
        { kind: "before", days: 30, time: { hour: 9, minute: 0 } },
        { kind: "before", days: 0, time: { hour: 14, minute: 30 } },
      ],
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    // São Paulo is a fixed UTC−3, so 09:00 is 12:00Z and 14:30 is 17:30Z.
    expect(result.rows.map((row) => row.scheduledAt.toISOString())).toEqual([
      "2026-08-11T12:00:00.000Z",
      "2026-09-10T17:30:00.000Z",
    ]);
  });

  it("rejects a negative days, which would state the direction twice", () => {
    // The kind already says which way; a sign as well could disagree with it.
    expect(() => plan({ triggers: [{ kind: "after", days: -7, time: { hour: 9, minute: 0 } }] })).toThrow(
      /non-negative integer/,
    );
    expect(() => plan({ triggers: [{ kind: "before", days: 1.5, time: { hour: 9, minute: 0 } }] })).toThrow(
      /non-negative integer/,
    );
  });

  it("falls back to days when less than a month has passed", () => {
    const result = plan({
      returnDate: "2026-03-25",
      // Earlier than the shared NOW, which sits exactly on the 14-day lead and
      // would be rejected as past before the elapsed text could be read.
      now: new Date("2026-03-10T18:00:00.000Z"),
      triggers: [
        { kind: "before", days: 0, time: { hour: 9, minute: 0 } },
        { kind: "before", days: 14, time: { hour: 9, minute: 0 } },
      ],
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    // 11/03 is one day after the service; 25/03 is fifteen.
    expect(result.rows[0]?.frozenText).toContain("Faz 1 dia ");
    expect(result.rows[1]?.frozenText).toContain("Faz 15 dias");
  });

  it("rejects a message with no triggers and creates nothing", () => {
    expect(plan({ triggers: [] })).toEqual({ status: "no_triggers" });
  });

  it("rejects a trigger already past, counting the confirm instant itself as past", () => {
    const past = new Date("2026-03-10T12:00:00.000Z");
    expect(plan({ triggers: [{ kind: "absolute", at: past }] })).toEqual({
      status: "trigger_in_past",
      at: past,
    });
    // The boundary: exactly now has passed, one millisecond later has not.
    expect(plan({ triggers: [{ kind: "absolute", at: NOW }] })).toEqual({
      status: "trigger_in_past",
      at: NOW,
    });
    const justAfter = new Date(NOW.getTime() + 1);
    expect(plan({ triggers: [{ kind: "absolute", at: justAfter }] }).status).toBe("ok");
  });

  it("rejects two triggers landing on the same instant", () => {
    const sameMoment = saoPaulo9am("2026-09-10");
    expect(
      plan({
        triggers: [
          { kind: "before", days: 0, time: { hour: 9, minute: 0 } },
          { kind: "absolute", at: sameMoment },
        ],
      }),
    ).toEqual({ status: "duplicate_trigger", at: sameMoment });
  });

  it("names the elapsed time, service, vehicle and interval, and keeps unknown tokens", () => {
    const result = plan({
      interval: { amount: 180, unit: "days" },
      bodyTemplate: `${DEFAULT_REMINDER_TEMPLATE} Fale com {{atendente}}.`,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    const text = result.rows[0]?.frozenText ?? "";
    expect(text).toContain("Faz 6 meses");
    expect(text).toContain("troca de óleo");
    expect(text).toContain("Toyota Corolla");
    expect(text).toContain("é de 180 dias");
    // An unresolved token stays visible rather than leaving a gap in a sent message.
    expect(text).toContain("{{atendente}}");
  });

  it("refuses a return date that is not a calendar day", () => {
    // The column is a `@db.Date`; an instant here would silently shift the day.
    expect(() => plan({ returnDate: "2026-09-10T00:00:00.000Z" })).toThrow(/YYYY-MM-DD/);
  });
});

describe("replanReminderRow", () => {
  const base = {
    performedAt: PERFORMED_AT,
    serviceLabel: "troca de óleo",
    vehicleLabel: "Toyota Corolla",
    interval: { amount: 6, unit: "months" } as const,
    bodyTemplate: DEFAULT_REMINDER_TEMPLATE,
    now: NOW,
  };

  it("moves an offset trigger with the date, keeping its hour and re-resolving the text", () => {
    const result = replanReminderRow({
      ...base,
      // The return moved two weeks later, to 24/09.
      returnDate: "2026-09-24",
      leadDays: 7,
      // The attendant had chosen 14:30 São Paulo (17:30Z) for this row.
      currentScheduledAt: new Date("2026-09-03T17:30:00.000Z"),
    });

    expect(result.status).toBe("move");
    if (result.status !== "move") {
      return;
    }
    // 7 days before 24/09 is 17/09, and the hour the attendant picked survives.
    expect(result.scheduledAt.toISOString()).toBe("2026-09-17T17:30:00.000Z");
    // Re-resolved for the new moment: 17/09 is more than six months after 10/03.
    expect(result.frozenText).toContain("Faz 6 meses");
  });

  it("leaves an absolute trigger exactly where the attendant put it", () => {
    const result = replanReminderRow({
      ...base,
      returnDate: "2026-11-24",
      // Null is the attendant naming an exact day rather than an offset.
      leadDays: null,
      currentScheduledAt: new Date("2026-09-03T17:30:00.000Z"),
    });

    expect(result).toEqual({ status: "keep" });
  });

  it("cancels with a Portuguese reason when the new instant has already passed", () => {
    const result = replanReminderRow({
      ...base,
      // Moved earlier, so 7 days before it lands before the confirm instant.
      returnDate: "2026-03-12",
      leadDays: 7,
      currentScheduledAt: new Date("2026-09-03T17:30:00.000Z"),
    });

    expect(result.status).toBe("cancel");
    if (result.status !== "cancel") {
      return;
    }
    // Not dispatched late, and not moved silently to the present.
    expect(result.scheduledAt.getTime()).toBeLessThan(NOW.getTime());
    expect(result.reason).toBe("A nova data de retorno colocaria este lembrete no passado.");
  });
});
