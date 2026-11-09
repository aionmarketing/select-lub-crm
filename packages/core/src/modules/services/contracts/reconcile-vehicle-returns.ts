/**
 * Brings every vehicle's return rows in line with its services — the
 * `compute-vehicle-returns` step.
 *
 * The decision of what a vehicle's returns should be is pure and lives in
 * `contracts/http.vehicle-return-plan.ts` (`planVehicleReturns`); this is the half that reads
 * rows and writes them. Moved from `packages/db/src/vehicle-returns.ts` in
 * adopt-modular-vertical-slices 3C, replacing 3A's stub, with the reads and the
 * plan unchanged. It lives in `contracts/` because its caller is another
 * module: `erp`'s `run-pull` reconciles after every import, and the demo seed
 * (`prisma/seed/demo.ts`) calls it too, so seeded returns are opened by the same
 * code as imported ones.
 *
 * TRANSACTIONS (3C ruling Q5). It used to run on the raw client in no
 * transaction at all, which is why it had to bypass the module-role check
 * (W3-C3): it writes `vehicle_return` (services') and stops reminders on
 * `scheduled_message` (scheduling'). Now the three loads each run in their own
 * `db.tx("services")`, and each VEHICLE's changes run in one `db.tx("services")`
 * — supersede, the nested `cancelRemindersOfReturns` (which runs under
 * scheduling's role through the kernel's savepoint and hands the services role
 * back), and open — so a return and its reminders commit or fail together. The
 * whole run is deliberately not one transaction: the seed and the backfill
 * reconcile every vehicle, and one transaction would hold them all under the
 * 5 s interactive-transaction cap.
 *
 * Idempotent: running it twice over unchanged data writes nothing the second
 * time, which is what makes it safe to call after every import.
 */
import { planVehicleReturns } from "./http.vehicle-return-plan.js";
import type { IntervalRuleInput } from "./http.return-due.js";
import { createDb, type Db, type DbClient } from "../../../kernel/db.js";
import { cancelRemindersOfReturns, moveReminderMessages } from "../../scheduling/contracts/reminder-rows.js";

/** What a reconcile run changed, for logging and for tests to assert on. */
export type ReconcileVehicleReturnsResult = {
  /** Vehicles examined. */
  vehicles: number;
  /** Returns opened. */
  opened: number;
  /** Returns moved to SUPERSEDED. */
  superseded: number;
  /** Un-sent reminders cancelled because the return they belonged to was superseded. */
  remindersCancelled: number;
  /** Reminder messages moved off a duplicate return onto the one kept. */
  remindersMerged: number;
};

const EMPTY: ReconcileVehicleReturnsResult = {
  vehicles: 0,
  opened: 0,
  superseded: 0,
  remindersCancelled: 0,
  remindersMerged: 0,
};

/** Interval rules as the planner needs them, loaded once per run. */
async function loadRules(prisma: DbClient): Promise<IntervalRuleInput[]> {
  const rows = await prisma.intervalRule.findMany({ where: { active: true } });
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    criterion: row.criterion,
    criterionId: row.criterionId,
    intervalAmount: row.intervalAmount,
    intervalUnit: row.intervalUnit === "days" ? "days" : "months",
    priority: row.priority,
    active: row.active,
    validFrom: row.validFrom,
    validTo: row.validTo,
  }));
}

/**
 * Brings every named vehicle's return rows in line with its services.
 *
 * @param db - The database handle.
 * @param options.vehicleIds - Restrict to these vehicles. Omit to reconcile
 *   every vehicle that has at least one service, which is the backfill.
 * @returns Counts of what changed, including reminders stopped because their
 *   return was superseded. All three are zero on a second run over unchanged
 *   data.
 */
export async function reconcileVehicleReturns(
  db: Db,
  options?: { vehicleIds?: string[] },
): Promise<ReconcileVehicleReturnsResult> {
  const scope = options?.vehicleIds;
  if (scope && scope.length === 0) {
    return EMPTY;
  }

  // Only vehicles with services can have a return, so the service table is the
  // source of the vehicle list rather than the vehicle table.
  const services = await db.tx("services", (prisma) =>
    prisma.service.findMany({
      where: { vehicleId: scope ? { in: scope } : { not: null } },
      select: { id: true, vehicleId: true, performedAt: true, kind: true },
      // A stable order: the planner lets the first of two same-day services win.
      orderBy: { id: "asc" },
    }),
  );
  const byVehicle = new Map<string, { id: string; performedAt: Date | null; kind: string | null }[]>();
  for (const row of services) {
    if (!row.vehicleId) {
      continue;
    }
    const list = byVehicle.get(row.vehicleId) ?? [];
    list.push({ id: row.id, performedAt: row.performedAt, kind: row.kind });
    byVehicle.set(row.vehicleId, list);
  }
  // Vehicles holding an OPEN return that no service points at any more (a
  // service's vehicle is SET NULL when the vehicle link goes, or it moved to
  // another car) are visited too, with no services: the planner then
  // supersedes their open returns, as it does for a vehicle whose services are
  // all undated. Before, the service table was the only source of the vehicle
  // list, so such a return stayed OPEN for ever — and the one-OPEN-return
  // migration, which names this reconcile as the fix, would keep refusing.
  const orphaned = await db.tx("services", (prisma) =>
    prisma.vehicleReturn.findMany({
      where: { status: "OPEN", ...(scope ? { vehicleId: { in: scope } } : {}) },
      select: { vehicleId: true },
      distinct: ["vehicleId"],
    }),
  );
  for (const row of orphaned) {
    if (!byVehicle.has(row.vehicleId)) {
      byVehicle.set(row.vehicleId, []);
    }
  }
  if (byVehicle.size === 0) {
    return EMPTY;
  }

  // OPEN and ARCHIVED, oldest first: the planner keeps the first of two OPEN
  // returns on one service, so this order is the tie-break (the same one the
  // unique-index migration used). ARCHIVED rows are read since the owner
  // rulings of 2026-09-25: an archived return on the latest service stops a new
  // one opening, and one on an older service is superseded.
  const returnRows = await db.tx("services", (prisma) =>
    prisma.vehicleReturn.findMany({
      where: { vehicleId: { in: [...byVehicle.keys()] }, status: { in: ["OPEN", "ARCHIVED"] } },
      select: { id: true, vehicleId: true, sourceServiceId: true, status: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  );
  const openByVehicle = new Map<string, { id: string; sourceServiceId: string }[]>();
  const archivedByVehicle = new Map<string, { id: string; sourceServiceId: string }[]>();
  for (const row of returnRows) {
    const byStatus = row.status === "OPEN" ? openByVehicle : archivedByVehicle;
    const list = byStatus.get(row.vehicleId) ?? [];
    list.push({ id: row.id, sourceServiceId: row.sourceServiceId });
    byStatus.set(row.vehicleId, list);
  }

  const rules = await db.tx("services", (prisma) => loadRules(prisma));
  let opened = 0;
  let superseded = 0;
  let remindersCancelled = 0;
  let remindersMerged = 0;

  for (const [vehicleId, vehicleServices] of byVehicle) {
    const plan = planVehicleReturns({
      services: vehicleServices,
      openReturns: openByVehicle.get(vehicleId) ?? [],
      archivedReturns: archivedByVehicle.get(vehicleId) ?? [],
      rules,
    });
    if (plan.supersede.length === 0 && !plan.open && !plan.merge) {
      continue;
    }

    await db.tx("services", async (prisma) => {
      // A duplicate's reminder messages move to the kept return BEFORE the
      // duplicate is superseded, so the cancel below never reaches them.
      if (plan.merge) {
        remindersMerged += await moveReminderMessages(createDb(prisma), {
          fromReturnIds: plan.merge.from,
          toReturnId: plan.merge.into,
        });
      }
      if (plan.supersede.length > 0) {
        const result = await prisma.vehicleReturn.updateMany({
          where: { id: { in: plan.supersede }, status: { in: ["OPEN", "ARCHIVED"] } },
          data: { status: "SUPERSEDED" },
        });
        superseded += result.count;
        // A superseded return is history: a newer service restarted the count, so
        // its un-sent reminders would tell the customer about a date that no
        // longer applies. SENT rows are left alone — one that has gone out cannot
        // be recalled — and so is anything mid-dispatch: the contract only
        // cancels rows still SCHEDULED, and does not count the rest.
        const stopped = await cancelRemindersOfReturns(createDb(prisma), {
          vehicleReturnIds: plan.supersede,
          at: new Date(),
          reason: "O retorno foi substituído por um serviço mais recente.",
        });
        remindersCancelled += stopped.cancelled;
      }

      if (plan.open) {
        // ON CONFLICT DO NOTHING against the one-OPEN-return-per-vehicle index
        // (migration 20260925140000_one_open_return_per_vehicle). This read and
        // this write are separate transactions, so a reconcile running at the
        // same time may have opened the vehicle's return in between; the loser
        // skips instead of failing. Not a caught P2002: inside db.tx that aborts
        // the whole transaction (25P02).
        const created = await prisma.vehicleReturn.createMany({
          data: [
            {
              vehicleId,
              sourceServiceId: plan.open.sourceServiceId,
              returnDate: plan.open.returnDate,
              status: "OPEN",
              intervalRuleId: plan.open.intervalRuleId,
              intervalRuleVersion: plan.open.intervalRuleVersion,
            },
          ],
          skipDuplicates: true,
        });
        opened += created.count;
      }
    });
  }

  return { vehicles: byVehicle.size, opened, superseded, remindersCancelled, remindersMerged };
}

/**
 * Opens, supersedes and stops vehicle returns after an ERP import.
 *
 * The name `erp`'s `run-pull` has called since 3A; every write now runs under
 * its owner's role (W3-C3 resolved in 3C).
 *
 * @param db - The database handle.
 * @returns Resolves when every vehicle's open return agrees with its latest service.
 */
export async function reconcileVehicleReturnsAfterImport(db: Db): Promise<void> {
  await reconcileVehicleReturns(db);
}
