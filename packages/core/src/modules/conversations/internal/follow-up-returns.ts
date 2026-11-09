/**
 * The two Follow-up return sections, built from stored vehicle returns.
 *
 * Pure. Callers load open returns and hand them over; nothing here reads a
 * clock beyond the `now` it is given, and nothing recomputes a return date —
 * the stored `returnDate` is authoritative and editable per vehicle, so
 * recomputing it here would undo an edit on every request.
 *
 * Moved from `apps/api/src/follow-up/return-sections.ts` (4A), unchanged;
 * `follow-up-aggregate.ts` composes it with the two message-pendency sections.
 *
 * The two sections deliberately do NOT share a shape. Vencido groups per
 * customer — one message to one person about every late car of theirs.
 * Aproximando is one row per customer-vehicle pair ordered by imminence,
 * because grouping it would destroy the only ordering it is read for: a
 * customer with cars due in 3 and in 12 days has no single position in that
 * order.
 */
import type { FollowUpDueVehicle, FollowUpOverdueEntry, FollowUpUpcomingEntry } from "../contracts/http.js";
import { classifyReturnDate } from "../../services/contracts/index.js";

/**
 * One vehicle return, joined to what the row needs to render.
 *
 * The caller decides which returns these are — OPEN ones for the queue,
 * closed ones for the closed-entries view. Nothing here reads a status.
 */
export type FollowUpOpenReturnRow = {
  returnId: string;
  vehicleId: string;
  /** Both absent is legal; the row renders the vehicle without them. */
  plate: string | null;
  model: string | null;
  customerId: string;
  customerName: string;
  conversationId: string | null;
  sourceServiceId: string;
  /** Calendar day the car is due, `YYYY-MM-DD` in America/Sao_Paulo. */
  returnDate: string;
  /** Un-sent reminders on this return; count 0 means none and is normalised away. */
  plannedReminderCount: number;
  /** Earliest un-sent reminder instant, ISO. Null when there are none. */
  nextReminderAt: string | null;
  /**
   * Thread message of the most recent reminder already sent for this return.
   * Absent while every reminder is still un-sent — there is no message yet.
   */
  sentReminderMessageId?: string;
  /** Set on a closed return: when it was closed and by whom. */
  closed?: { at: string; byUserId: string };
};

/** Both sections, each already ordered and capped by the caller. */
export type FollowUpReturnSections = {
  overdue: FollowUpOverdueEntry[];
  upcoming: FollowUpUpcomingEntry[];
};

function toVehicle(row: FollowUpOpenReturnRow): FollowUpDueVehicle {
  return {
    vehicleId: row.vehicleId,
    plate: row.plate,
    model: row.model,
    returnId: row.returnId,
    returnDate: row.returnDate,
    sourceServiceId: row.sourceServiceId,
    ...(row.sentReminderMessageId ? { sentReminderMessageId: row.sentReminderMessageId } : {}),
    ...(row.closed ? { closed: row.closed } : {}),
    // Absent rather than a zero count: "none planned" and "two planned" are
    // different claims, and a zero would be a second way to say the first.
    ...(row.plannedReminderCount > 0 && row.nextReminderAt
      ? {
          plannedReminders: {
            count: row.plannedReminderCount,
            nextAt: row.nextReminderAt,
          },
        }
      : {}),
  };
}

/**
 * Splits open returns into the two sections.
 *
 * @param rows - Every return in scope — OPEN ones for the queue, closed ones
 *   for the closed-entries view. Superseded returns must already be excluded by
 *   the caller; this does not filter by status, because a row that should not
 *   be listed should not have been loaded.
 * @param today - Today's calendar day in America/Sao_Paulo, `YYYY-MM-DD`.
 * @param horizon - The last day counted as approaching, `YYYY-MM-DD`
 *   (today + 14). Passed rather than derived so the caller owns the clock.
 * @param cap - Maximum entries per section, applied to each section's own
 *   entry shape — customers for vencido, rows for aproximando.
 * @returns Both sections, ordered most urgent first.
 */
export function buildReturnSections(
  rows: FollowUpOpenReturnRow[],
  today: string,
  horizon: string,
  cap: number,
): FollowUpReturnSections {
  const overdueRows: FollowUpOpenReturnRow[] = [];
  const upcomingRows: FollowUpOpenReturnRow[] = [];
  for (const row of rows) {
    const state = classifyReturnDate(row.returnDate, today, horizon);
    if (state === "vencido") {
      overdueRows.push(row);
    } else if (state === "aproximando") {
      upcomingRows.push(row);
    }
  }

  // Vencido: one entry per customer, that customer's vehicles most overdue
  // first, and customers ordered by their own most overdue vehicle.
  const byCustomer = new Map<string, FollowUpOpenReturnRow[]>();
  for (const row of overdueRows) {
    const list = byCustomer.get(row.customerId) ?? [];
    list.push(row);
    byCustomer.set(row.customerId, list);
  }
  const overdue = [...byCustomer.values()]
    .map((group) => {
      const sorted = [...group].sort((a, b) => a.returnDate.localeCompare(b.returnDate));
      const head = sorted[0] as FollowUpOpenReturnRow;
      return {
        entry: {
          customerId: head.customerId,
          conversationId: head.conversationId,
          label: head.customerName,
          vehicles: sorted.map(toVehicle),
        } satisfies FollowUpOverdueEntry,
        // The customer's worst vehicle decides where the customer sits.
        rank: head.returnDate,
      };
    })
    .sort((a, b) => a.rank.localeCompare(b.rank))
    .slice(0, cap)
    .map((row) => row.entry);

  // Aproximando: one row per pair, strictly by date. A customer with two cars
  // due appears twice, and another customer's row may sit between them — that
  // interleaving is the point, not a defect.
  const upcoming = [...upcomingRows]
    .sort((a, b) => a.returnDate.localeCompare(b.returnDate))
    .slice(0, cap)
    .map(
      (row): FollowUpUpcomingEntry => ({
        customerId: row.customerId,
        conversationId: row.conversationId,
        label: row.customerName,
        vehicle: toVehicle(row),
      }),
    );

  return { overdue, upcoming };
}
