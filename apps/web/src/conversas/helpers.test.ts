/**
 * Test design (testing-strategy)
 *
 * Setup: call exported helpers from helpers.ts. No DOM except where named.
 *
 * Oracle: openspec/specs/conversations/conversas — list contact label is name when known
 * else phone; thread date separators are America/Sao_Paulo civil days;
 * image/audio/video/document are playable media and attach MIME maps to
 * those types (else document); one-schedule occupied = a non-cancelled row that
 * is NOT a return reminder — a return may carry several reminders, all naming
 * the service it was dated from, so those never occupy it (decided 2026-09-03).
 *
 * Axes
 *   A1 contact name — non-empty / whitespace-only / null
 *   A2 media type — image|audio|video|document|text
 *   A3 phone digits — empty / mixed punctuation / already digits
 *   A4 performedAt / amount / km — null vs present vs unparseable
 *   A5 service sort — both dated / one null / both null
 *   A6 schedule occupy — matching SCHEDULED / matching CANCELLED / other id /
 *      matching SCHEDULED that is a return reminder (does not occupy)
 *   A7 price raw — comma decimal / negative / empty
 *   A8 accept field — year / odometerKm / plate
 *   A9 prefill fields — undefined / empty / plate set
 *  A10 inbox timestamp age — same São Paulo day / previous day / 2-6 days /
 *      7+ days. Boundary: the 6th and 7th day either side of the weekday-vs-date
 *      cut, and a 23:50 message read at 00:10 (the "Ontem" case elapsed hours
 *      would get wrong).
 *
 * Outputs
 *   O1 name or phone label
 *   O2 playable vs not; MIME → messageType
 *   O3 WhatsApp Web URL with or without phone=
 *   O4 formatted date / amount / km or ""
 *   O5 sort order; occupied boolean
 *   O6 parsed price or null
 *   O7 accept body number vs string
 *   O8 prefill rows or []
 *   O9 inbox timestamp — clock time / "Ontem" / weekday abbreviation / date
 *
 * Sampled-cell
 *   known name            | A1 name     | O1 | phone shown
 *   blank name            | A1 ws/null  | O1 | invented name
 *   image playable        | A2 image    | O2 | unsupported
 *   text not playable     | A2 text     | O2 | treated as media
 *   MIME image/audio/vid  | A2 mime     | O2 | document
 *   other MIME document   | A2 other    | O2 | image
 *   empty phone URL       | A3 empty    | O3 | phone=
 *   punctuated phone      | A3 mixed    | O3 | leftover punctuation
 *   null performedAt      | A4 null     | O4 | invented date
 *   ISO performedAt       | A4 iso      | O4 | TZ-shifted day
 *   garbage performedAt   | A4 bad      | O4 | partial parse
 *   null amount/km        | A4 null     | O4 | "null" / "0 km"
 *   both dated sort       | A5 dated    | O5 | oldest first
 *   one/both null sort    | A5 nulls    | O5 | dated buried
 *   occupied SCHEDULED    | A6 match    | O5 | free
 *   cancelled / other id  | A6 F        | O5 | blocked
 *   comma price           | A7 comma    | O6 | null
 *   negative/empty price  | A7 invalid  | O6 | 0
 *   year/km/plate accept  | A8          | O7 | string year
 *   prefill undef/empty   | A9          | O8 | invented plate
 *
 * Decision / branch map (helpers.ts)
 *   whatsappWebUrl digits     T punctuated it; F empty it
 *   isPlayableMedia           T image it; F text it
 *   messageTypeFromFile image T; audio T; video T; else document
 *   conversasContactLabel     T name it; F blank/null its
 *   formatPerformedAt !iso    T null it; F ISO it
 *   formatPerformedAt !match  T garbage it; F ISO it
 *   formatAmount == null      T null it; F number it
 *   formatOdometer == null    T null it; F number it
 *   vehicleIdentity !vehicle  T undefined it; F plated it
 *   year == null              T year-less it; F year it
 *   serviceHasNonCancelled    T SCHEDULED it; F cancelled + other-id its
 *   sort both null            T both-null it; F dated it
 *   sort a null               T a-null it
 *   sort b null               T b-null it
 *   parseOfferedPrice empty   T empty it; F comma it
 *   parseOfferedPrice finite  T comma it; F negative it
 *   acceptBodyFor year        T year it; F plate it
 *   acceptBodyFor odometerKm  T km it; F plate it
 *
 * isoToDatetimeLocal `?.value ?? ""` — contract-hidden: en-GB formatToParts
 * always emits year/month/day/hour/minute for a valid Date.
 * useDebouncedValue timer T: ConversasPage inbox search; F unmount cleanup
 * is React contract-hidden.
 *
 * Out of scope: UI copy in inbox/thread/rail (ConversasPage.* / App.test).
 */
import { describe, expect, it } from "vitest";
import type { ScheduledMessage, Service, Vehicle } from "@select-lub/shared-types";
import {
  acceptBodyFor,
  conversasContactLabel,
  datetimeLocalToIso,
  dayKey,
  formatAmount,
  formatOdometer,
  formatPerformedAt,
  formatScheduleDate,
  isPlayableMedia,
  isoToDatetimeLocal,
  joinDot,
  messageTypeFromFile,
  parseOfferedPrice,
  serviceHasNonCancelledSchedule,
  sortServicesRecentFirst,
  vehicleIdentity,
  whatsappWebUrl,
  formatInboxTimestamp,
} from "./helpers.js";

function vehicle(partial: Partial<Vehicle> = {}): Vehicle {
  return {
    id: "v1",
    customerId: "c1",
    omieId: null,
    plate: "ABC1D23",
    make: "Fiat",
    model: "Argo",
    version: null,
    year: 2020,
    odometerKm: 1000,
    origin: "crm",
    plateSourcedKeys: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

function service(partial: Partial<Service> = {}): Service {
  return {
    id: "s1",
    customerId: "c1",
    vehicleId: "v1",
    omieId: null,
    unitId: "u1",
    performedAt: "2026-08-01T12:00:00.000Z",
    description: "Troca",
    kind: "oil",
    status: null,
    amount: 100,
    odometerKm: 1000,
    origin: "crm",
    items: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

function schedule(partial: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return {
    id: "sch1",
    customerId: "c1",
    conversationId: "conv1",
    serviceId: "s1",
    returnReminderMessageId: null,
    templateId: null,
    text: "oi",
    scheduledAt: "2026-09-01T15:00:00.000Z",
    timeZone: "America/Sao_Paulo",
    status: "SCHEDULED",
    idempotencyKey: "k1",
    suggestedAt: null,
    suggestionSource: null,
    createdByUserId: "u1",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

describe("conversas helpers", () => {
  it("uses the stored name as the contact label when it is non-empty", () => {
    expect(conversasContactLabel("Maria Silva", "5511999990000")).toBe("Maria Silva");
  });

  it("falls back to the phone when the name is missing or only whitespace", () => {
    expect(conversasContactLabel(null, "5511999990000")).toBe("5511999990000");
    expect(conversasContactLabel("   ", "5511999990000")).toBe("5511999990000");
  });

  it("treats image audio video and document as playable media", () => {
    expect(isPlayableMedia("image")).toBe(true);
    expect(isPlayableMedia("text")).toBe(false);
  });

  it("maps file MIME types to outbox message types", () => {
    expect(messageTypeFromFile(new File([], "a.png", { type: "image/png" }))).toBe(
      "image",
    );
    expect(messageTypeFromFile(new File([], "a.mp3", { type: "audio/mpeg" }))).toBe(
      "audio",
    );
    expect(messageTypeFromFile(new File([], "a.mp4", { type: "video/mp4" }))).toBe(
      "video",
    );
    expect(
      messageTypeFromFile(new File([], "a.pdf", { type: "application/pdf" })),
    ).toBe("document");
  });

  it("builds a WhatsApp Web send URL from digits, or the generic home when none remain", () => {
    expect(whatsappWebUrl("11 99999-0000")).toBe(
      "https://web.whatsapp.com/send?phone=11999990000",
    );
    expect(whatsappWebUrl("")).toBe("https://web.whatsapp.com/");
    expect(whatsappWebUrl()).toBe("https://web.whatsapp.com/");
  });

  it("formats performedAt from the ISO calendar prefix without shifting the civil day", () => {
    expect(formatPerformedAt("2026-08-26T03:00:00.000Z")).toBe("26/08/2026");
    expect(formatPerformedAt(null)).toBe("");
    expect(formatPerformedAt("not-iso")).toBe("");
  });

  it("formats São Paulo schedule dates and datetime-local round-trips at UTC−3", () => {
    expect(formatScheduleDate("2026-08-26T15:00:00.000Z")).toBe("26/08/2026");
    expect(isoToDatetimeLocal("2026-08-26T15:00:00.000Z")).toBe("2026-08-26T12:00");
    expect(datetimeLocalToIso("2026-08-26T12:00")).toBe("2026-08-26T15:00:00.000Z");
  });

  it("uses America/Sao_Paulo civil days for thread separators", () => {
    expect(dayKey("2026-08-25T15:00:00.000Z")).toBe("2026-08-25");
    expect(dayKey("2026-08-26T15:00:00.000Z")).toBe("2026-08-26");
  });

  it("omits amount and odometer when the stored value is null", () => {
    expect(formatAmount(null)).toBe("");
    expect(formatOdometer(null)).toBe("");
    expect(formatAmount(10)).toMatch(/10/);
    expect(formatOdometer(1500)).toMatch(/1.?500 km/);
  });

  it("builds a vehicle identity line and drops blank fragments", () => {
    expect(vehicleIdentity(undefined)).toBe("");
    expect(vehicleIdentity(vehicle({ make: "Fiat", model: "Argo", year: 2020 }))).toBe(
      "Fiat Argo 2020",
    );
    expect(vehicleIdentity(vehicle({ make: "Fiat", model: null, year: null }))).toBe(
      "Fiat",
    );
    expect(joinDot(["a", "", null, "b"])).toBe("a · b");
  });

  it("sorts services newest performedAt first and keeps undated rows last", () => {
    const older = service({ id: "old", performedAt: "2026-01-01T00:00:00.000Z" });
    const newer = service({ id: "new", performedAt: "2026-08-01T00:00:00.000Z" });
    const undated = service({ id: "none", performedAt: null });
    const otherUndated = service({ id: "none2", performedAt: null });
    expect(
      sortServicesRecentFirst([older, newer]).map((row: Service) => row.id),
    ).toEqual(["new", "old"]);
    expect(
      sortServicesRecentFirst([undated, newer]).map((row: Service) => row.id),
    ).toEqual(["new", "none"]);
    expect(
      sortServicesRecentFirst([newer, undated]).map((row: Service) => row.id),
    ).toEqual(["new", "none"]);
    expect(
      sortServicesRecentFirst([undated, otherUndated]).map((row: Service) => row.id),
    ).toEqual(["none", "none2"]);
  });

  it("treats a non-cancelled schedule on the same service as occupied", () => {
    expect(
      serviceHasNonCancelledSchedule(
        [schedule({ status: "SCHEDULED", serviceId: "s1" })],
        "s1",
      ),
    ).toBe(true);
    expect(
      serviceHasNonCancelledSchedule(
        [schedule({ status: "CANCELLED", serviceId: "s1" })],
        "s1",
      ),
    ).toBe(false);
    expect(
      serviceHasNonCancelledSchedule(
        [schedule({ status: "SCHEDULED", serviceId: "other" })],
        "s1",
      ),
    ).toBe(false);
    // A return's reminder names the service the return was dated from, but does
    // not occupy it: a return may carry several reminders, so counting one here
    // would make Criar lembrete unavailable from the second one onwards.
    expect(
      serviceHasNonCancelledSchedule(
        [
          schedule({
            status: "SCHEDULED",
            serviceId: "s1",
            returnReminderMessageId: "rem-1",
          }),
        ],
        "s1",
      ),
    ).toBe(false);
  });

  it("parses offered prices and rejects empty or negative input", () => {
    expect(parseOfferedPrice("12,50")).toBe(12.5);
    expect(parseOfferedPrice("-1")).toBeNull();
    expect(parseOfferedPrice("")).toBeNull();
    expect(parseOfferedPrice("   ")).toBeNull();
  });

  it("coerces year and odometer accept bodies to numbers and leaves plate as string", () => {
    expect(acceptBodyFor("year", "2020")).toEqual({ field: "year", value: 2020 });
    expect(acceptBodyFor("odometerKm", "1500")).toEqual({
      field: "odometerKm",
      value: 1500,
    });
    expect(acceptBodyFor("plate", "ABC1D23")).toEqual({
      field: "plate",
      value: "ABC1D23",
    });
  });

  describe("formatInboxTimestamp", () => {
    // Wednesday 2026-09-09, 14:00 in São Paulo (UTC-3).
    const now = new Date("2026-09-09T17:00:00.000Z");

    it("shows the clock time for a message from the same São Paulo day", () => {
      expect(formatInboxTimestamp("2026-09-09T12:30:00.000Z", now)).toBe("09:30");
    });

    it("says Ontem for the previous São Paulo day", () => {
      expect(formatInboxTimestamp("2026-09-08T13:00:00.000Z", now)).toBe("Ontem");
    });

    it("says Ontem just after midnight, when only twenty minutes have elapsed", () => {
      // 23:50 São Paulo on the 8th, read at 00:10 on the 9th: a rule counting
      // elapsed hours would call this "today" and print a clock time.
      const justAfterMidnight = new Date("2026-09-09T03:10:00.000Z");

      expect(formatInboxTimestamp("2026-09-09T02:50:00.000Z", justAfterMidnight)).toBe(
        "Ontem",
      );
    });

    it.each([
      ["three days ago", "2026-09-06T17:00:00.000Z", "Dom"],
      ["six days ago", "2026-09-03T17:00:00.000Z", "Qui"],
    ])("shows the abbreviated weekday %s", (_label, iso, expected) => {
      expect(formatInboxTimestamp(iso, now)).toBe(expected);
    });

    it.each([
      ["seven days ago", "2026-09-02T17:00:00.000Z"],
      ["eight days ago", "2026-09-01T17:00:00.000Z"],
    ])("shows the short date %s", (_label, iso) => {
      expect(formatInboxTimestamp(iso, now)).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    });
  });
});
