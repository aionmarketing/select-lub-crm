/**
 * Editing a return's date.
 *
 * Moved from `packages/db/src/vehicle-return-date.ts` in adopt-modular-vertical-
 * slices 3C. Internal, with no route: nothing in production calls it yet, only
 * its tests (W3-C7). Its reminder writes are `scheduling`'s contracts now,
 * called INSIDE the transaction that moves the return, so the return and its
 * reminders still commit together (3C ruling Q5); each contract is
 * compare-and-set on `SCHEDULED`, and a 0 means the due tick claimed the row
 * first — it is left alone and counted as kept.
 *
 * The stored `returnDate` is authoritative: Follow-up's sections, the Serviços
 * return-state filter and every reminder default read it rather than recompute
 * it from the service plus the rule. Recomputing on read is exactly what made an
 * edited date impossible before returns became rows.
 *
 * `reconcileVehicleReturns` leaves an edit alone: it re-dates nothing, and only
 * opens a return when the vehicle's newest dated service has none. A newer
 * service still supersedes an edited return, because the edit was about the old
 * service's cadence and the new service restarts the count.
 *
 * Only an OPEN return can be moved (decided 2026-09-03). An archived return
 * shows in neither Follow-up section nor either count, so editing it would be a
 * change nobody can see land — unarchive it first.
 *
 * Moving the date carries the return's un-sent reminders with it. Only offset
 * triggers follow: an absolute date is the attendant naming an exact day, and
 * overriding that would discard the one thing they were explicit about.
 *
 * Archiving does NOT touch reminders (decided 2026-09-03), so every un-sent
 * reminder on a return is simply `SCHEDULED` and there is no set-aside state
 * for this to reason about.
 */
import { replanReminderRow } from "../../scheduling/contracts/http.js";
import { createDb, type Db } from "../../../kernel/db.js";
import { cancelReminderRow, moveReminderRow } from "../../scheduling/contracts/reminder-rows.js";

/** Outcome of moving a return's date, and what it did to the reminders. */
export type SetReturnDateResult =
  | {
      status: "ok";
      returnDate: string;
      /** Offset reminders moved to the new instant with their text re-resolved. */
      moved: number;
      /** Reminders whose new instant had already passed. */
      cancelled: number;
      /** Reminders left untouched: absolute triggers, and anything already sent. */
      kept: number;
    }
  | { status: "not_found" }
  | { status: "archived" }
  | { status: "superseded" };

/**
 * Moves one return to a new calendar day.
 *
 * Clears the interval-rule link, which records that the date no longer came from
 * the rule. The rule itself is untouched — editing one car's cadence must not
 * change policy for every other car — and no other return moves.
 *
 * @param db - The database handle.
 * @param input.returnId - The return to move.
 * @param input.returnDate - The new day, `YYYY-MM-DD` in America/Sao_Paulo. A
 *   calendar day rather than an instant, because the column is a `@db.Date` and
 *   nobody sets a time of day for "this car is due".
 * @param input.now - Instant a recomputed reminder must still be after. Injected
 *   so a test can place one either side of it without waiting.
 * @returns The stored day and what happened to the reminders on success;
 *   `not_found` for an unknown return, and
 *   `archived` for one set aside (unarchive it first, since an archived return
 *   shows nowhere); and `superseded` for one a newer service replaced, which is
 *   history that moving would claim is still live.
 * @throws When `returnDate` is not a `YYYY-MM-DD` day.
 */
export async function setVehicleReturnDate(
  db: Db,
  input: { returnId: string; returnDate: string; now?: Date },
): Promise<SetReturnDateResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.returnDate)) {
    throw new Error(`returnDate must be YYYY-MM-DD, got ${input.returnDate}`);
  }

  const row = await db.tx("services", (prisma) =>
    prisma.vehicleReturn.findUnique({
      where: { id: input.returnId },
      select: { id: true, status: true },
    }),
  );
  if (!row) {
    return { status: "not_found" };
  }
  // Only an open return can be moved. An archived one is absent from both
  // Follow-up sections and both counts, so editing it would be a change nobody
  // can see land; unarchive first. A superseded one is history that a newer
  // service replaced. The two are distinct so the caller can say which it is.
  if (row.status === "ARCHIVED") {
    return { status: "archived" };
  }
  if (row.status !== "OPEN") {
    return { status: "superseded" };
  }

  const now = input.now ?? new Date();

  return db.tx("services", async (tx) => {
    const reminders = createDb(tx);
    const updated = await tx.vehicleReturn.update({
      where: { id: input.returnId },
      data: {
        returnDate: new Date(`${input.returnDate}T00:00:00.000Z`),
        // Null means "this date did not come from a rule" — the same thing it
        // means on a return that fell back to the six-month default.
        intervalRuleId: null,
        intervalRuleVersion: null,
      },
      include: {
        intervalRule: true,
        sourceService: { select: { performedAt: true, kind: true, description: true } },
        vehicle: { select: { make: true, model: true, plate: true } },
      },
    });

    // The un-sent rows. SENT has left and FAILED is finished, so neither is
    // moved nor rewritten, and PROCESSING is mid-dispatch — moving it would
    // race the worker for a row it has already claimed.
    const rows = await tx.scheduledMessage.findMany({
      where: {
        status: "SCHEDULED",
        returnReminderMessage: { vehicleReturnId: input.returnId, cancelledAt: null },
      },
      select: {
        id: true,
        leadDays: true,
        scheduledAt: true,
        returnReminderMessage: { select: { bodyTemplate: true } },
      },
    });

    let moved = 0;
    let cancelled = 0;
    let kept = 0;

    for (const row of rows) {
      const plan = replanReminderRow({
        returnDate: input.returnDate,
        leadDays: row.leadDays,
        currentScheduledAt: row.scheduledAt,
        // A return whose service lost its date can no longer be re-resolved, so
        // its rows are left exactly as they are rather than half-rewritten.
        performedAt: updated.sourceService.performedAt ?? row.scheduledAt,
        serviceLabel:
          updated.sourceService.kind ?? updated.sourceService.description ?? "manutenção",
        vehicleLabel:
          [updated.vehicle.make, updated.vehicle.model].filter(Boolean).join(" ") ||
          updated.vehicle.plate ||
          "seu veículo",
        interval: updated.intervalRule
          ? {
              amount: updated.intervalRule.intervalAmount,
              unit: updated.intervalRule.intervalUnit === "days" ? "days" : "months",
            }
          : { amount: 6, unit: "months" },
        bodyTemplate: row.returnReminderMessage?.bodyTemplate ?? "",
        now,
      });

      if (plan.status === "keep") {
        kept += 1;
        continue;
      }
      if (plan.status === "move") {
        const changed = await moveReminderRow(reminders, {
          scheduledMessageId: row.id,
          scheduledAt: plan.scheduledAt,
          frozenText: plan.frozenText,
          now,
        });
        // 0: the due tick claimed the row since it was read — already being
        // sent, so it is left exactly as it is.
        if (changed === 0) {
          kept += 1;
        } else {
          moved += 1;
        }
        continue;
      }
      // Still in the past after the move, so it can only be dispatched late.
      // Cancelled with the reason recorded rather than slid to the present.
      const changed = await cancelReminderRow(reminders, {
        scheduledMessageId: row.id,
        at: now,
        reason: plan.reason,
      });
      if (changed === 0) {
        kept += 1;
      } else {
        cancelled += 1;
      }
    }

    return {
      status: "ok",
      returnDate: updated.returnDate.toISOString().slice(0, 10),
      moved,
      cancelled,
      kept,
    };
  });
}
