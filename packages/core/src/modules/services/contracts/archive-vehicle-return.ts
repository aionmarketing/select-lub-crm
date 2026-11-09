/**
 * Archiving a vehicle return and undoing it — WRITES to `vehicle_return`, which
 * `services` owns.
 *
 * Moved from `packages/db/src/vehicle-return-archive.ts` in adopt-modular-vertical-
 * slices 3C, replacing 3B's stub. `scheduling`'s `archive-vehicle-return` and
 * `unarchive-vehicle-return` routes check the unit and the state, then call
 * these; each runs in one `db.tx("services", …)`, so the write is made under the
 * table owner's role whoever calls it. Correction C4 had described this file as
 * a read `services` would expose; it is writes only (W3-C7), and Follow-up's read
 * of archived returns is a direct foreign read in `apps/api`'s `follow-up`.
 *
 * Archiving takes the row off the Follow-up queue and does nothing else
 * (decided 2026-09-03). It is a statement about the operator's list, not about
 * the customer: **Arquivar** means "take this off my list", not "stop messaging
 * this person".
 *
 * So reminders are untouched. A reminder exists only because someone
 * deliberately created it, and stopping one is its own action on the reminder
 * itself — cancelling that message, or cancelling a single moment of it. Tying
 * the two together meant an operator tidying their queue silently stopped
 * messages they had not thought about, which is the opposite of deliberate.
 *
 * Archiving is still reversible: unarchiving puts the return back on the queue.
 * Nothing else has to be undone, because nothing else was done.
 */
import { Prisma } from "@select-lub/core/db";
import type { Db } from "../../../kernel/db.js";

/**
 * Unarchiving was refused because the vehicle already has an OPEN return
 * (owner rulings, 2026-09-25).
 *
 * The reconcile supersedes an archived return once a newer service arrives,
 * so this is normally caught earlier as "not ARCHIVED". It remains for the
 * race, and for the ARCHIVED + OPEN pairs earlier imports left on one service:
 * the one-OPEN-return-per-vehicle index refuses the second OPEN row, and the
 * route answers it with the same 409 `return_not_archived`.
 */
export class VehicleReturnAlreadyOpenError extends Error {
  constructor(returnId: string) {
    super(`vehicle return ${returnId} cannot be unarchived: its vehicle already has an open return`);
    this.name = "VehicleReturnAlreadyOpenError";
  }
}

/**
 * Archives one return, taking it off both Follow-up return sections.
 *
 * Its reminders keep their schedule and keep sending. That is deliberate — see
 * this module's header. The state check and the write share one transaction.
 *
 * @param db - The database handle; the work runs on `db.tx("services", …)`.
 * @param input.returnId - The return to archive.
 * @param input.userId - Who archived it, recorded on the row.
 * @throws When the return does not exist, or is not `OPEN` — a superseded
 *   return is already off the queue and archiving it would claim otherwise.
 */
export async function archiveVehicleReturn(
  db: Db,
  input: { returnId: string; userId: string },
): Promise<void> {
  await db.tx("services", async (prisma) => {
    const row = await prisma.vehicleReturn.findUnique({
      where: { id: input.returnId },
      select: { id: true, status: true },
    });
    if (!row) {
      throw new Error(`vehicle return ${input.returnId} not found`);
    }
    if (row.status !== "OPEN") {
      throw new Error(`vehicle return ${input.returnId} is ${row.status}, not OPEN`);
    }

    await prisma.vehicleReturn.update({
      where: { id: input.returnId },
      data: { status: "ARCHIVED", archivedAt: new Date(), archivedByUserId: input.userId },
    });
  });
}

/**
 * Puts an archived return back on the Follow-up queue.
 *
 * @param db - The database handle; the work runs on `db.tx("services", …)`.
 * @param input.returnId - The return to unarchive.
 * @throws When the return does not exist or is not `ARCHIVED`;
 *   {@link VehicleReturnAlreadyOpenError} when its vehicle already has an OPEN return.
 */
export async function unarchiveVehicleReturn(db: Db, input: { returnId: string }): Promise<void> {
  // The unique violation is caught here, OUTSIDE the transaction: db.tx has
  // already rolled back. Caught inside it, the transaction would be aborted
  // (25P02) for anything that ran after.
  await db.tx("services", async (prisma) => {
    const row = await prisma.vehicleReturn.findUnique({
      where: { id: input.returnId },
      select: { id: true, status: true },
    });
    if (!row) {
      throw new Error(`vehicle return ${input.returnId} not found`);
    }
    if (row.status !== "ARCHIVED") {
      throw new Error(`vehicle return ${input.returnId} is ${row.status}, not ARCHIVED`);
    }

    await prisma.vehicleReturn.update({
      where: { id: input.returnId },
      data: { status: "OPEN", archivedAt: null, archivedByUserId: null },
    });
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new VehicleReturnAlreadyOpenError(input.returnId);
    }
    throw error;
  });
}
