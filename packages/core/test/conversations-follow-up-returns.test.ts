/**
 * Test design (testing-strategy)
 *
 * SUT: buildReturnSections — pure split of open vehicle returns into Retorno
 * vencido (grouped per customer) and Retorno se aproximando (one row per
 * customer-vehicle pair). No clock: today and the horizon are arguments.
 *
 * Oracle: follow-up — "vencido SHALL present one entry per customer ... listing
 *   every one of that customer's overdue vehicles"; "aproximando SHALL present
 *   one entry per customer-vehicle pair ... ordered by return date ascending";
 *   "grouping it by customer would destroy that ordering"; counts follow each
 *   section's own entry shape. shared-types — the reminder summary is absent
 *   rather than zero.
 *
 * Axes
 *   A1 returnDate vs today — before / equal / after. Ordered, so BVA on the
 *      vencido boundary: today−1, today, today+1.
 *   A2 returnDate vs horizon — inside / equal / beyond. BVA: horizon−1,
 *      horizon, horizon+1.
 *   A3 vehicles per customer in one section — one / several
 *   A4 the same customer across both sections — present / absent
 *   A5 planned reminders on a return — none / some, and one customer holding
 *      several overdue cars where only ONE carries a reminder
 *   A6 cap — under / at (vencido counts customers, aproximando counts rows, so
 *      the same row set caps differently in each)
 *
 * Outputs
 *   O1 vencido: one entry per customer, vehicles most overdue first
 *   O2 vencido entries ordered by each customer's worst vehicle
 *   O3 aproximando: one row per pair, strictly by date
 *   O4 a second customer's row sits between one customer's two rows
 *   O5 plannedReminders absent when none, count+nextAt when some, and present on
 *      the one vehicle that has it rather than on every vehicle its owner holds
 *   O6 cap applied per section's own entry shape
 *
 * Sampled-cell
 *   two customers, three overdue cars | A1 A3     | O1 O2   | a row per car, or a customer listed twice
 *   boundary at today                 | A1 BVA    | O1      | today counted overdue, or dropped entirely
 *   boundary at the horizon           | A2 BVA    | O3      | horizon excluded, or beyond it included
 *   customer in both sections         | A4        | O1 O3   | deduplicated to one section
 *   interleaved by date               | A4 A3     | O4      | grouped by customer, breaking the order
 *   reminders present and absent      | A5        | O5      | a zero count, or a null nextAt
 *   one owner, three cars, one reminder | A5 A3   | O5      | the summary spreading to the owner's other cars, or the car with it being hidden
 *   cap counts entries, not rows      | A6        | O6      | vencido capped by vehicles
 *
 * Decision / branch map (return-sections.ts)
 *   returnDate < today                T overdue its; F boundary-at-today it
 *   returnDate <= horizon             T upcoming its; F beyond-horizon it
 *   plannedReminderCount > 0 && nextAt T reminders-present it; F reminders-absent it
 *   row.closed / row.sentReminderMessageId  T the closed-return it; F the live-return it
 *
 *   A7 return state — live / closed, since the closed-entries view reads the
 *      same builder and must keep the reminder summary standing
 *
 * Out of scope: which returns are OPEN (the caller filters; a row that should
 *   not be listed should not have been loaded), and the date math that produced
 *   returnDate (shared-types' return-due).
 */
import { describe, expect, it } from "vitest";
import { buildReturnSections, type FollowUpOpenReturnRow } from "../src/modules/conversations/internal/follow-up-returns.js";

const TODAY = "2026-09-02";
const HORIZON = "2026-09-16";

function row(over: Partial<FollowUpOpenReturnRow> & { returnId: string }): FollowUpOpenReturnRow {
  return {
    vehicleId: `veh-${over.returnId}`,
    plate: "ABC-1D23",
    model: "Toyota Corolla",
    customerId: "cust-1",
    customerName: "Ana Souza",
    conversationId: null,
    sourceServiceId: `svc-${over.returnId}`,
    returnDate: TODAY,
    plannedReminderCount: 0,
    nextReminderAt: null,
    ...over,
  };
}

describe("buildReturnSections", () => {
  it("carries a closed return's reminders and its closer through to the vehicle", () => {
    // Closing a return takes it off the queue and does nothing else (task
    // 11.11a, migration 20260903210000_archiving_leaves_reminders_alone):
    // Arquivar is a statement about the operator's list, not about the
    // customer. So the closed-entries view has to show the reminders still
    // standing — a summary that vanished here would be the screen implying
    // messages were stopped that were not.
    const { overdue } = buildReturnSections(
      [
        row({
          returnId: "r-closed",
          returnDate: "2026-08-21",
          plannedReminderCount: 2,
          nextReminderAt: "2026-09-04T12:00:00.000Z",
          closed: { at: "2026-09-01T09:00:00.000Z", byUserId: "user-1" },
          sentReminderMessageId: "m-sent",
        }),
      ],
      TODAY,
      HORIZON,
      100,
    );

    const vehicle = overdue[0]?.vehicles[0];
    expect(vehicle?.closed).toEqual({ at: "2026-09-01T09:00:00.000Z", byUserId: "user-1" });
    expect(vehicle?.plannedReminders).toEqual({ count: 2, nextAt: "2026-09-04T12:00:00.000Z" });
    expect(vehicle?.sentReminderMessageId).toBe("m-sent");
  });

  it("omits the closed and sent-message fields on a live return", () => {
    const { overdue } = buildReturnSections(
      [row({ returnId: "r-open", returnDate: "2026-08-21" })],
      TODAY,
      HORIZON,
      100,
    );

    // Absent rather than null: the queue's rows are not closed, and a null
    // would be a second way of saying so.
    expect(overdue[0]?.vehicles[0]).not.toHaveProperty("closed");
    expect(overdue[0]?.vehicles[0]).not.toHaveProperty("sentReminderMessageId");
  });

  it("groups vencido per customer and orders each by its worst vehicle", () => {
    const { overdue } = buildReturnSections(
      [
        row({ returnId: "r1", customerId: "c1", customerName: "Ana", returnDate: "2026-08-21" }),
        row({ returnId: "r2", customerId: "c1", customerName: "Ana", returnDate: "2026-05-30" }),
        row({ returnId: "r3", customerId: "c2", customerName: "Carlos", returnDate: "2026-07-16" }),
      ],
      TODAY,
      HORIZON,
      100,
    );

    expect(overdue).toHaveLength(2);
    // Ana leads: her worst car (30/05) is worse than Carlos's (16/07).
    expect(overdue[0]?.label).toBe("Ana");
    expect(overdue[0]?.vehicles.map((v) => v.returnDate)).toEqual(["2026-05-30", "2026-08-21"]);
    expect(overdue[1]?.vehicles).toHaveLength(1);
  });

  it("counts today as not yet overdue and yesterday as overdue", () => {
    const { overdue, upcoming } = buildReturnSections(
      [
        row({ returnId: "yesterday", customerId: "c1", returnDate: "2026-09-01" }),
        row({ returnId: "today", customerId: "c2", returnDate: TODAY }),
      ],
      TODAY,
      HORIZON,
      100,
    );

    expect(overdue).toHaveLength(1);
    expect(overdue[0]?.vehicles[0]?.returnDate).toBe("2026-09-01");
    // Due today is approaching, not late: the day has not passed yet.
    expect(upcoming.map((e) => e.vehicle.returnDate)).toEqual([TODAY]);
  });

  it("includes the horizon day and excludes the day after it", () => {
    const { upcoming } = buildReturnSections(
      [
        row({ returnId: "on", customerId: "c1", returnDate: HORIZON }),
        row({ returnId: "after", customerId: "c2", returnDate: "2026-09-17" }),
      ],
      TODAY,
      HORIZON,
      100,
    );

    expect(upcoming.map((e) => e.vehicle.returnDate)).toEqual([HORIZON]);
  });

  it("lists one customer in both sections when their cars differ", () => {
    const { overdue, upcoming } = buildReturnSections(
      [
        row({ returnId: "late", customerId: "c1", customerName: "Carlos", returnDate: "2026-07-16" }),
        row({ returnId: "soon", customerId: "c1", customerName: "Carlos", returnDate: "2026-09-12" }),
      ],
      TODAY,
      HORIZON,
      100,
    );

    expect(overdue).toHaveLength(1);
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]?.customerId).toBe("c1");
  });

  it("orders aproximando strictly by date, interleaving customers", () => {
    const { upcoming } = buildReturnSections(
      [
        row({ returnId: "a", customerId: "c1", customerName: "Carlos", returnDate: "2026-09-05" }),
        row({ returnId: "b", customerId: "c2", customerName: "Paulo", returnDate: "2026-09-08" }),
        row({ returnId: "c", customerId: "c1", customerName: "Carlos", returnDate: "2026-09-14" }),
      ],
      TODAY,
      HORIZON,
      100,
    );

    // Paulo sits between Carlos's two cars. Grouping by customer would move him
    // to one end and misreport when the other two are due.
    expect(upcoming.map((e) => e.label)).toEqual(["Carlos", "Paulo", "Carlos"]);
  });

  it("omits the reminder summary when there are none and reports it when there are", () => {
    const { upcoming } = buildReturnSections(
      [
        row({ returnId: "bare", customerId: "c1", returnDate: "2026-09-05" }),
        row({
          returnId: "planned",
          customerId: "c2",
          returnDate: "2026-09-06",
          plannedReminderCount: 2,
          nextReminderAt: "2026-09-04T12:00:00.000Z",
        }),
      ],
      TODAY,
      HORIZON,
      100,
    );

    expect(upcoming[0]?.vehicle.plannedReminders).toBeUndefined();
    expect(upcoming[1]?.vehicle.plannedReminders).toEqual({
      count: 2,
      nextAt: "2026-09-04T12:00:00.000Z",
    });
  });

  it("lights only the car that has a reminder, not every car its owner holds", () => {
    // The regression this pins: the summary used to be computed per CUSTOMER,
    // so one scheduled message marked every vehicle that customer owned. Three
    // overdue cars, one reminder — the other two must come back bare.
    const { overdue } = buildReturnSections(
      [
        row({ returnId: "r1", customerId: "c1", customerName: "Ana", returnDate: "2026-08-01" }),
        row({
          returnId: "r2",
          customerId: "c1",
          customerName: "Ana",
          returnDate: "2026-08-02",
          plannedReminderCount: 2,
          nextReminderAt: "2026-09-04T12:00:00.000Z",
        }),
        row({ returnId: "r3", customerId: "c1", customerName: "Ana", returnDate: "2026-08-03" }),
      ],
      TODAY,
      HORIZON,
      100,
    );

    expect(overdue).toHaveLength(1);
    const vehicles = overdue[0]?.vehicles ?? [];
    expect(vehicles).toHaveLength(3);
    expect(vehicles.map((vehicle) => vehicle.plannedReminders?.count ?? null)).toEqual([
      null,
      2,
      null,
    ]);
    // And the car WITH a reminder is still listed rather than hidden by it: the
    // section is about the car being due, not about whether anyone has written
    // to the customer. That is what keeps Criar lembrete reachable on it, since
    // a return may carry several reminders.
    expect(vehicles.some((vehicle) => vehicle.returnId === "r2")).toBe(true);
  });

  it("caps vencido by customers and aproximando by rows", () => {
    const overdueRows = [
      row({ returnId: "o1", customerId: "c1", returnDate: "2026-08-01" }),
      row({ returnId: "o2", customerId: "c1", returnDate: "2026-08-02" }),
      row({ returnId: "o3", customerId: "c2", returnDate: "2026-08-03" }),
    ];
    const upcomingRows = [
      row({ returnId: "u1", customerId: "c1", returnDate: "2026-09-05" }),
      row({ returnId: "u2", customerId: "c1", returnDate: "2026-09-06" }),
    ];

    const capped = buildReturnSections([...overdueRows, ...upcomingRows], TODAY, HORIZON, 1);

    // One customer, but that entry still carries BOTH of their overdue cars —
    // the cap counts entries, and an entry is a customer here.
    expect(capped.overdue).toHaveLength(1);
    expect(capped.overdue[0]?.vehicles).toHaveLength(2);
    // Aproximando's entry is a pair, so the same cap admits one row.
    expect(capped.upcoming).toHaveLength(1);
  });
});
