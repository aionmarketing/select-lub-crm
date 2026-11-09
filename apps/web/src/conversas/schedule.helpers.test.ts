/**
 * Test design (testing-strategy)
 *
 * Setup: the four pure helpers exported by `schedule.tsx`. No DOM, no HTTP,
 * no fake timers — every input is a literal, so these cannot flake under a
 * parallel run.
 *
 * Oracle: the MODULE CONTRACT — the JSDoc on each helper — not an OpenSpec
 * requirement. Recorded deliberately, because it is the weaker oracle:
 * `conversas/spec.md` and `design-system/mvp-screen-designs` fix the São
 * Paulo zone and which rows each surface lists ("recent items only" for the
 * preview, the full list behind Ver tudo), but NEITHER names a sort key for
 * either list. So the ordering asserted here pins the behaviour the module
 * says it has; it is not traceable to a SHALL. If the owner wants a
 * different order, the spec is what has to change first, and these tests are
 * what will notice.
 *
 * Per-helper oracle, cited so a reader can check it rather than take my word
 * that one exists — and each was verified to AGREE with its code before
 * being used, since a JSDoc can itself be wrong (this same module set
 * produced exactly that: `vehicle-plate.ts:77` claimed a "failed or
 * unavailable" lookup is retried when the code retries only `failed`):
 *   `formatScheduleInstant`  schedule.tsx:63 — `@returns DD/MM/YYYY HH:mm`.
 *     The shape is documented, not merely observed.
 *   `sortSchedulesNewestFirst`  schedule.tsx:79-80 — "Newest `createdAt`
 *     first — the order the rail PREVIEW reads in". Code sorts
 *     `b.createdAt.localeCompare(a.createdAt)`; agrees.
 *   `sortSchedulesBySendOrder`  schedule.tsx:88-90 — "Soonest pending send
 *     first, then resolved rows most recent first". Code sorts pending
 *     ascending and resolved descending on `scheduledAt`; agrees.
 *   `scheduleRowTitle`  schedule.tsx:102-108 — first line of frozen text;
 *     a first line longer than 40 characters is cut there and given an
 *     ellipsis; 40 itself stays whole. Owner pinned that budget 2026-09-08.
 *
 * Axes
 *   A1 instant → zone: mid-day (no day shift) / after 21:00 São Paulo
 *      (UTC has already rolled over) / São Paulo midnight
 *   A2 schedule status: pending {SCHEDULED, PROCESSING} / resolved
 *      {SENT, CANCELLED, FAILED} — the partition `sortSchedulesBySendOrder`
 *      splits on
 *   A3 row population: mixed / pending only / resolved only / empty
 *   A4 title length, ordered → BVA on the `> 40` edge: 39 / 40 / 41
 *   A5 title shape: single line / several lines / empty
 *
 * Outputs
 *   O1 `DD/MM/YYYY HH:mm` in São Paulo civil time
 *   O2 an order (asserted as the id sequence, so a failure names the rows)
 *   O3 a title string, truncated or whole
 *
 * Sampled cells (one row per `it`)
 *   mid-day instant        | A1 no shift   | O1 | fails if UTC is rendered
 *   late instant           | A1 day rolls  | O1 | fails if the civil DAY comes
 *                            over in UTC          from UTC — the off-by-one-day
 *   São Paulo midnight     | A1 00:00      | O1 | fails under a 12-hour cycle
 *                                                 ("12:00 AM") or an h24 "24:00"
 *   preview order          | A3 mixed      | O2 | fails if not createdAt desc
 *   preview does not mutate| A3 mixed      | O2 | fails if the `[...rows]` copy
 *                                                 is dropped and the caller's
 *                                                 array is reordered in place
 *   send order, mixed      | A2 both, A3   | O2 | fails if a resolved row sorts
 *                            mixed                among the pending ones, or if
 *                                                 either half's direction flips
 *   PROCESSING is pending  | A2 boundary   | O2 | fails if the split tests
 *                                                 `=== "SCHEDULED"` rather than
 *                                                 the two-status set
 *   pending only           | A3 one half   | O2 | fails if the resolved branch
 *   resolved only          | A3 other half | O2 | contributes when it is empty
 *   empty input            | A3 empty      | O2 | fails if it throws on []
 *   title 39 / 40 / 41     | A4 BVA        | O3 | fails if 39/40 grow an
 *                                                ellipsis, or 41 stays whole
 *   title several lines    | A5            | O3 | fails if lines 2+ leak in
 *   title empty            | A5            | O3 | fails if it throws
 *
 * Decision / branch map
 *   `sortSchedulesNewestFirst` comparator
 *     b > a — preview-order `it`; b < a — same `it` (both directions occur
 *     across one unsorted input); equal — NOT sampled, see out of scope
 *   `sortSchedulesBySendOrder` `PENDING.includes(row.status)` in the pending
 *     filter — T: SCHEDULED and PROCESSING rows; F: the three resolved rows
 *   the same predicate negated in the resolved filter — T and F likewise
 *   pending comparator ascending / resolved comparator descending
 *     both directions taken in the mixed `it`; each is additionally isolated
 *     by the pending-only and resolved-only its, so a flipped direction cannot
 *     hide behind the other half
 *   `scheduleRowTitle` `firstLine.length > 40`
 *     T: 41-character it (ellipsis); F: 39- and 40-character its (whole).
 *     The multi-line and empty-text its exercise the first-line split
 *     without depending on the threshold.
 *   `scheduleRowTitle` `text.split("\n")[0] ?? ""`
 *     right side INFEASIBLE: `String.prototype.split` always returns at least
 *     one element, so index 0 is never `undefined`. Not sampled, and no input
 *     can sample it.
 *
 * Out of scope, with reason
 *   - Ties in both sorts (two rows sharing a `createdAt` or a `scheduledAt`).
 *     Neither the spec nor the module says which wins, and asserting the
 *     engine's stable-sort order would pin an implementation detail rather
 *     than a contract. Named here so a later reader sees it was a decision.
 *   - `SCHEDULE_STATUS_LABELS`: a constant map with no decision in it. Its
 *     rendered use is covered by `ConversasPage.scheduled.test.tsx`.
 *   - The three React components in `schedule.tsx` (`ScheduleMessageDialog`,
 *     `ServiceRailRow`, `ScheduledRailRow`): rendered behaviour, already
 *     exercised through `ConversasPage.scheduled.test.tsx`.
 */
import { describe, expect, it } from "vitest";
import type { ScheduledMessage, ScheduledMessageStatus } from "@select-lub/shared-types";
import {
  formatScheduleInstant,
  scheduleRowTitle,
  sortSchedulesBySendOrder,
  sortSchedulesNewestFirst,
} from "./schedule.js";

/**
 * A valid row where only the three fields the sorts read — id, status,
 * scheduledAt, createdAt — carry meaning. Everything else is fixed so a
 * reordering assertion cannot accidentally depend on it.
 */
function row(fields: {
  id: string;
  status?: ScheduledMessageStatus;
  scheduledAt?: string;
  createdAt?: string;
}): ScheduledMessage {
  return {
    id: fields.id,
    customerId: "cus_1",
    conversationId: "con_1",
    serviceId: null,
    returnReminderMessageId: null,
    templateId: null,
    text: "Lembrete de revisão",
    scheduledAt: fields.scheduledAt ?? "2026-08-10T12:00:00.000Z",
    timeZone: "America/Sao_Paulo",
    status: fields.status ?? "SCHEDULED",
    idempotencyKey: `idem-${fields.id}`,
    suggestedAt: null,
    suggestionSource: null,
    createdByUserId: "usr_1",
    createdAt: fields.createdAt ?? "2026-08-01T12:00:00.000Z",
  };
}

const ids = (rows: ScheduledMessage[]) => rows.map((r) => r.id);

describe("formatScheduleInstant", () => {
  it("renders the São Paulo civil time of a mid-day instant", () => {
    // 15:00Z is 12:00 at UTC−3, same calendar day either way.
    const formatted = formatScheduleInstant("2026-08-10T15:00:00.000Z");

    expect(formatted).toBe("10/08/2026 12:00");
  });

  it("keeps the São Paulo day when UTC has already rolled into the next one", () => {
    // 02:00Z on the 11th is still 23:00 on the 10th in São Paulo. Rendering
    // the UTC date here would show 11/08 — a reminder listed under the wrong
    // day, which is the failure this case exists for.
    const formatted = formatScheduleInstant("2026-08-11T02:00:00.000Z");

    expect(formatted).toBe("10/08/2026 23:00");
  });

  it("writes São Paulo midnight as 00:00 rather than 12 AM or 24:00", () => {
    const formatted = formatScheduleInstant("2026-08-10T03:00:00.000Z");

    expect(formatted).toBe("10/08/2026 00:00");
  });
});

describe("sortSchedulesNewestFirst", () => {
  it("orders the rail preview by newest createdAt first", () => {
    const rows = [
      row({ id: "middle", createdAt: "2026-08-02T12:00:00.000Z" }),
      row({ id: "oldest", createdAt: "2026-08-01T12:00:00.000Z" }),
      row({ id: "newest", createdAt: "2026-08-03T12:00:00.000Z" }),
    ];

    expect(ids(sortSchedulesNewestFirst(rows))).toEqual(["newest", "middle", "oldest"]);
  });

  it("leaves the caller's array in its original order", () => {
    const rows = [
      row({ id: "older", createdAt: "2026-08-01T12:00:00.000Z" }),
      row({ id: "newer", createdAt: "2026-08-03T12:00:00.000Z" }),
    ];

    sortSchedulesNewestFirst(rows);

    expect(ids(rows)).toEqual(["older", "newer"]);
  });
});

describe("sortSchedulesBySendOrder", () => {
  it("puts every pending row, soonest send first, ahead of the resolved ones newest first", () => {
    const rows = [
      row({ id: "sent", status: "SENT", scheduledAt: "2026-07-01T12:00:00.000Z" }),
      row({ id: "pending-late", status: "SCHEDULED", scheduledAt: "2026-09-20T12:00:00.000Z" }),
      row({ id: "failed", status: "FAILED", scheduledAt: "2026-07-20T12:00:00.000Z" }),
      row({ id: "pending-soon", status: "SCHEDULED", scheduledAt: "2026-09-01T12:00:00.000Z" }),
      row({ id: "cancelled", status: "CANCELLED", scheduledAt: "2026-07-10T12:00:00.000Z" }),
    ];

    expect(ids(sortSchedulesBySendOrder(rows))).toEqual([
      "pending-soon",
      "pending-late",
      "failed",
      "cancelled",
      "sent",
    ]);
  });

  it("sorts a PROCESSING row among the pending ones rather than after them", () => {
    // The split is over two statuses, not just SCHEDULED. An implementation
    // testing `status === "SCHEDULED"` would drop this row into the resolved
    // half and put it last, so its position is the whole assertion.
    const rows = [
      row({ id: "sent", status: "SENT", scheduledAt: "2026-07-01T12:00:00.000Z" }),
      row({ id: "scheduled", status: "SCHEDULED", scheduledAt: "2026-09-20T12:00:00.000Z" }),
      row({ id: "processing", status: "PROCESSING", scheduledAt: "2026-09-01T12:00:00.000Z" }),
    ];

    expect(ids(sortSchedulesBySendOrder(rows))).toEqual(["processing", "scheduled", "sent"]);
  });

  it("orders a list of only pending rows by soonest send", () => {
    const rows = [
      row({ id: "later", status: "SCHEDULED", scheduledAt: "2026-09-20T12:00:00.000Z" }),
      row({ id: "sooner", status: "PROCESSING", scheduledAt: "2026-09-01T12:00:00.000Z" }),
    ];

    expect(ids(sortSchedulesBySendOrder(rows))).toEqual(["sooner", "later"]);
  });

  it("orders a list of only resolved rows by most recent send", () => {
    const rows = [
      row({ id: "older", status: "SENT", scheduledAt: "2026-07-01T12:00:00.000Z" }),
      row({ id: "recent", status: "CANCELLED", scheduledAt: "2026-07-20T12:00:00.000Z" }),
    ];

    expect(ids(sortSchedulesBySendOrder(rows))).toEqual(["recent", "older"]);
  });

  it("returns an empty list for an empty input", () => {
    expect(sortSchedulesBySendOrder([])).toEqual([]);
  });

  it("leaves the caller's array in its original order", () => {
    const rows = [
      row({ id: "sent", status: "SENT", scheduledAt: "2026-07-01T12:00:00.000Z" }),
      row({ id: "pending", status: "SCHEDULED", scheduledAt: "2026-09-01T12:00:00.000Z" }),
    ];

    sortSchedulesBySendOrder(rows);

    expect(ids(rows)).toEqual(["sent", "pending"]);
  });
});

describe("scheduleRowTitle", () => {
  // BVA on the `> 40` edge. 40 is the value that separates `>` from `>=`:
  // it must come back whole, ellipsis-free. Oracle: schedule.tsx JSDoc
  // (owner pinned 40 on 2026-09-08).
  const thirtyNine = "a".repeat(39);
  const forty = "b".repeat(40);
  const fortyOne = "c".repeat(41);

  it("returns a 39-character line unchanged", () => {
    expect(scheduleRowTitle(thirtyNine)).toBe(thirtyNine);
  });

  it("returns a 40-character line unchanged, without an ellipsis", () => {
    expect(scheduleRowTitle(forty)).toBe(forty);
  });

  it("truncates a 41-character line to 40 characters plus an ellipsis", () => {
    expect(scheduleRowTitle(fortyOne)).toBe(`${"c".repeat(40)}…`);
  });

  it("titles a multi-line message by its first line alone", () => {
    expect(scheduleRowTitle("Olá, tudo bem?\nSua revisão vence amanhã.")).toBe("Olá, tudo bem?");
  });

  it("returns an empty title for empty text", () => {
    expect(scheduleRowTitle("")).toBe("");
  });
});
