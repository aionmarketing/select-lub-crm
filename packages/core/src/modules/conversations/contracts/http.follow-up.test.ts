/**
 * Test design (testing-strategy)
 *
 * Setup: zod parse / safeParse on Follow-up result and counts schemas. No HTTP.
 *
 * Oracle: openspec/changes/follow-up-screen/specs/shared-types/spec.md
 *   + follow-up/spec.md — shared contract; invalid payloads fail;
 *   counts equal listed lengths; each list capped at 100.
 *
 * Techniques: EP (one invalid class per `it`), BVA on list cap
 * (100 ok / 101 reject), decision coverage of required fields.
 *
 * ----------------------------------------------------------------------------
 * Axes
 * ----------------------------------------------------------------------------
 * A1 result payload
 *   EP valid: four lists + matching counts
 *   EP invalid: missing counts; 101 quote rows (max 100); negative count
 * A2 counts vs lists
 *   EP valid: count === list.length (including zeros)
 * A3 return entry flag
 *   EP valid: plannedReminders present | absent
 *   EP invalid: omitted flag
 * A4 conversationId on returns
 *   EP valid: string; null
 *
 * Outputs: O1 parse success; O2 safeParse.success === false
 *
 * ----------------------------------------------------------------------------
 * Sampled-cell table
 * ----------------------------------------------------------------------------
 * | `it`                                      | axes        | Out | fails if |
 * | parses four empty lists + zero counts     | A1/A2 empty | O1  | throws |
 * | parses populated lists with matching counts | A1 valid  | O1  | throws |
 * | 101 unanswered quote rows                 | A1 cap     | O2  | success true |
 * | negative overdue count                    | A1 invalid | O2  | success true |
 * | missing counts                            | A1 invalid | O2  | success true |
 * | return flag omitted                       | A3 invalid | O2  | success true |
 * | return conversationId null                | A4 null    | O1  | throws |
 *
 * Out of scope: HTTP (follow-up.route.test.ts); UI (FollowUpPage.test.tsx).
 */

import { describe, expect, it } from "vitest";
import { FOLLOW_UP_LIST_CAP, followUpDueVehicleSchema, followUpOptionalCountsSchema, followUpOverdueEntrySchema, followUpResultSchema, followUpUpcomingEntrySchema } from "./http.follow-up.js";

const emptyLists = {
  unansweredQuotes: [] as [],
  overdueReturns: [] as [],
  upcomingReturns: [] as [],
  waitingReply: [] as [],
};

const emptyCounts = {
  unansweredQuotes: 0,
  overdueReturns: 0,
  upcomingReturns: 0,
  waitingReply: 0,
};

describe("split return entry shapes", () => {
  const vehicle = {
    vehicleId: "veh-1",
    plate: "ABC-1D23",
    model: "Toyota Corolla",
    returnId: "ret-1",
    returnDate: "2026-07-16",
    sourceServiceId: "svc-1",
  };

  it("accepts a vencido entry grouping several vehicles under one customer", () => {
    const parsed = followUpOverdueEntrySchema.parse({
      customerId: "cust-1",
      conversationId: null,
      label: "Ana Souza",
      vehicles: [vehicle, { ...vehicle, vehicleId: "veh-2", returnId: "ret-2" }],
    });

    expect(parsed.vehicles).toHaveLength(2);
  });

  it("rejects a vencido entry with no vehicles", () => {
    // An entry exists BECAUSE a car is due; one with none is a row about nothing.
    expect(
      followUpOverdueEntrySchema.safeParse({
        customerId: "cust-1",
        conversationId: null,
        label: "Ana Souza",
        vehicles: [],
      }).success,
    ).toBe(false);
  });

  it("gives an aproximando entry exactly one vehicle, not a list", () => {
    const parsed = followUpUpcomingEntrySchema.parse({
      customerId: "cust-1",
      conversationId: null,
      label: "Paulo Lima",
      vehicle,
    });

    expect(parsed.vehicle.vehicleId).toBe("veh-1");
    expect(followUpUpcomingEntrySchema.safeParse({
      customerId: "cust-1",
      conversationId: null,
      label: "Paulo Lima",
      vehicles: [vehicle],
    }).success).toBe(false);
  });

  it("omits the reminder summary rather than reporting a count of zero", () => {
    const none = followUpDueVehicleSchema.parse(vehicle);
    expect(none.plannedReminders).toBeUndefined();
    // Zero is not a legal count: absent means none, so a zero would be a second
    // way to say the same thing and a consumer would have to handle both.
    expect(
      followUpDueVehicleSchema.safeParse({
        ...vehicle,
        plannedReminders: { count: 0, nextAt: "2026-09-05T12:00:00.000Z" },
      }).success,
    ).toBe(false);
  });

  it("carries the count and the next instant when reminders exist", () => {
    const parsed = followUpDueVehicleSchema.parse({
      ...vehicle,
      plannedReminders: { count: 2, nextAt: "2026-09-04T12:00:00.000Z" },
    });

    expect(parsed.plannedReminders).toEqual({
      count: 2,
      nextAt: "2026-09-04T12:00:00.000Z",
    });
  });

  it("lets a count be absent, which is not the same as zero", () => {
    const unknown = followUpOptionalCountsSchema.parse({ overdueReturns: 2 });

    expect(unknown.overdueReturns).toBe(2);
    expect("unansweredQuotes" in unknown).toBe(false);
    // Zero still parses and still means "nothing pending".
    expect(followUpOptionalCountsSchema.parse({ unansweredQuotes: 0 }).unansweredQuotes).toBe(0);
  });
});

describe("followUpResultSchema", () => {
  it("parses four empty lists with matching zero counts", () => {
    const parsed = followUpResultSchema.parse({
      counts: emptyCounts,
      ...emptyLists,
    });
    expect(parsed.counts).toEqual(emptyCounts);
    expect(parsed.unansweredQuotes).toEqual([]);
  });

  it("parses populated lists when counts match listed lengths", () => {
    const parsed = followUpResultSchema.parse({
      counts: {
        unansweredQuotes: 1,
        overdueReturns: 1,
        upcomingReturns: 0,
        waitingReply: 1,
      },
      unansweredQuotes: [
        {
          conversationId: "c1",
          quoteId: "q1",
          quoteMessageId: null,
          quoteSentAt: "2026-08-28T12:00:00.000Z",
          label: "Roberto",
        },
      ],
      overdueReturns: [
        {
          customerId: "cust-1",
          conversationId: "c2",
          label: "Carlos",
          vehicles: [
            {
              vehicleId: "veh-1",
              plate: "ABC-1D23",
              model: "Toyota Corolla",
              returnId: "ret-1",
              returnDate: "2026-07-15",
              sourceServiceId: "svc-1",
              plannedReminders: { count: 2, nextAt: "2026-09-04T12:00:00.000Z" },
            },
          ],
        },
      ],
      upcomingReturns: [],
      waitingReply: [
        {
          conversationId: "c3",
          oldestPendingAt: "2026-08-27T10:00:00.000Z",
          label: "Juliana",
        },
      ],
    });
    expect(parsed.counts.unansweredQuotes).toBe(parsed.unansweredQuotes.length);
    expect(parsed.overdueReturns[0]?.vehicles[0]?.plannedReminders?.count).toBe(2);
  });

  it("rejects 101 unanswered quote rows", () => {
    const row = {
      conversationId: "c",
      quoteId: "q",
      quoteSentAt: "2026-08-01T00:00:00.000Z",
      label: "x",
    };
    const result = followUpResultSchema.safeParse({
      counts: { ...emptyCounts, unansweredQuotes: FOLLOW_UP_LIST_CAP + 1 },
      ...emptyLists,
      unansweredQuotes: Array.from({ length: FOLLOW_UP_LIST_CAP + 1 }, (_, i) => ({
        ...row,
        conversationId: `c${i}`,
        quoteId: `q${i}`,
      })),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative overdue count", () => {
    const result = followUpOptionalCountsSchema.safeParse({ overdueReturns: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects a result missing counts", () => {
    const result = followUpResultSchema.safeParse(emptyLists);
    expect(result.success).toBe(false);
  });

  it("rejects a return entry without the já-agendada flag", () => {
    const result = followUpResultSchema.safeParse({
      counts: { ...emptyCounts, overdueReturns: 1 },
      ...emptyLists,
      overdueReturns: [
        {
          customerId: "cust-1",
          conversationId: "c2",
          lastServiceId: "svc-1",
          lastPerformedAt: "2026-01-15T12:00:00.000Z",
          returnDate: "2026-07-15",
          label: "Carlos",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("parses a return entry with conversationId null", () => {
    const parsed = followUpResultSchema.parse({
      counts: { ...emptyCounts, upcomingReturns: 1 },
      ...emptyLists,
      upcomingReturns: [
        {
          customerId: "cust-2",
          conversationId: null,
          label: "Paulo",
          vehicle: {
            vehicleId: "veh-2",
            plate: null,
            model: null,
            returnId: "ret-2",
            returnDate: "2026-09-10",
            sourceServiceId: "svc-2",
          },
        },
      ],
    });
    expect(parsed.upcomingReturns[0]?.conversationId).toBeNull();
  });
});
