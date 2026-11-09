/**
 * Reconciliation pendings: the open conflicts between a CRM value and an Omie value.
 *
 * Moved from `apps/api/src/cadastro/prisma.ts` with bodies unchanged, except for how
 * `saveOpenPending` survives a race on the open row (one open row per owner and field,
 * a partial unique index). The API's store caught the unique violation and re-read;
 * inside `db.tx("customers", …)` that violation aborts the transaction, so the re-read
 * failed with 25P02. The insert is now `ON CONFLICT DO NOTHING` (`skipDuplicates`),
 * which waits for the racing insert to commit and aborts nothing, then re-reads and
 * updates the winner — the same outcome. Pinned by `cadastro.pending-lifecycle.live`.
 * Writes `customer_reconciliation_pending` and `vehicle_reconciliation_pending`.
 */
import type { DbClient } from "@select-lub/core/db";
import type { CadastroStore, PendingRow } from "./port.js";
import type { OmieSharedFieldKey } from "../../../../shared/web/omie-field-keys.js";

/** The reconciliation methods of the cadastro store. */
export type ReconcileMethods = Pick<
  CadastroStore,
  "getOpenPending" | "saveOpenPending" | "listOpenPendings" | "closeOpenPending" | "listOpenPendingsForUnit"
>;

/**
 * The reconciliation methods, over one client.
 *
 * @param prisma - The `customers` transaction the call runs in.
 * @returns The methods, with their bodies as the API's store had them.
 */
export function reconcileMethods(prisma: DbClient): ReconcileMethods {
  const methods: ReconcileMethods = {
    async getOpenPending(owner, fieldKey) {
      if ("vehicleId" in owner) {
        const row = await prisma.vehicleReconciliationPending.findFirst({
          where: { vehicleId: owner.vehicleId, fieldKey, status: "open" } });
        if (!row) {
          return null;
        }
        const vehicle = await prisma.vehicle.findUnique({ where: { id: owner.vehicleId } });
        return {
          fieldKey: row.fieldKey as OmieSharedFieldKey,
          crmValue: row.crmValue,
          omieValue: row.omieValue,
          localVersion: row.localVersion,
          externalVersion: row.externalVersion,
          status: "open" as const,
          customerId: vehicle?.customerId ?? "",
          vehicleId: row.vehicleId };
      }
      const row = await prisma.customerReconciliationPending.findFirst({
        where: { customerId: owner.customerId, fieldKey, status: "open" } });
      if (!row) {
        return null;
      }
      return {
        fieldKey: row.fieldKey as OmieSharedFieldKey,
        crmValue: row.crmValue,
        omieValue: row.omieValue,
        localVersion: row.localVersion,
        externalVersion: row.externalVersion,
        status: "open" as const,
        customerId: row.customerId,
        vehicleId: null };
    },
    async saveOpenPending(row: PendingRow) {
      const values = {
        crmValue: row.crmValue,
        omieValue: row.omieValue,
        localVersion: row.localVersion,
        externalVersion: row.externalVersion,
        status: row.status };
      if (row.vehicleId) {
        const vehicleId = row.vehicleId;
        const existing = await prisma.vehicleReconciliationPending.findFirst({
          where: { vehicleId, fieldKey: row.fieldKey, status: "open" } });
        if (existing) {
          await prisma.vehicleReconciliationPending.update({
            where: { id: existing.id },
            data: values });
          return;
        }
        const created = await prisma.vehicleReconciliationPending.createMany({
          data: [{ vehicleId, fieldKey: row.fieldKey, ...values }],
          skipDuplicates: true });
        if (created.count === 1) {
          return;
        }
        const raced = await prisma.vehicleReconciliationPending.findFirst({
          where: { vehicleId, fieldKey: row.fieldKey, status: "open" } });
        if (!raced) {
          throw new Error("pending_race_unresolved");
        }
        await prisma.vehicleReconciliationPending.update({
          where: { id: raced.id },
          data: values });
        return;
      }
      const existing = await prisma.customerReconciliationPending.findFirst({
        where: { customerId: row.customerId, fieldKey: row.fieldKey, status: "open" } });
      if (existing) {
        await prisma.customerReconciliationPending.update({
          where: { id: existing.id },
          data: values });
        return;
      }
      const created = await prisma.customerReconciliationPending.createMany({
        data: [{ customerId: row.customerId, fieldKey: row.fieldKey, ...values }],
        skipDuplicates: true });
      if (created.count === 1) {
        return;
      }
      const raced = await prisma.customerReconciliationPending.findFirst({
        where: { customerId: row.customerId, fieldKey: row.fieldKey, status: "open" } });
      if (!raced) {
        throw new Error("pending_race_unresolved");
      }
      await prisma.customerReconciliationPending.update({
        where: { id: raced.id },
        data: values });
    },
    async listOpenPendings(customerId) {
      const person = await prisma.customerReconciliationPending.findMany({
        where: { customerId, status: "open" } });
      const vehicle = await prisma.vehicle.findFirst({
        where: { customerId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      const vehicleRows = vehicle
        ? await prisma.vehicleReconciliationPending.findMany({
            where: { vehicleId: vehicle.id, status: "open" } })
        : [];
      return [
        ...person.map((row) => ({
          fieldKey: row.fieldKey as OmieSharedFieldKey,
          crmValue: row.crmValue,
          omieValue: row.omieValue,
          localVersion: row.localVersion,
          externalVersion: row.externalVersion,
          status: "open" as const,
          customerId: row.customerId,
          vehicleId: null })),
        ...vehicleRows.map((row) => ({
          fieldKey: row.fieldKey as OmieSharedFieldKey,
          crmValue: row.crmValue,
          omieValue: row.omieValue,
          localVersion: row.localVersion,
          externalVersion: row.externalVersion,
          status: "open" as const,
          customerId,
          vehicleId: row.vehicleId })),
      ];
    },
    async closeOpenPending(owner, fieldKey, resolvedByUserId) {
      const data = { status: "resolved", resolvedByUserId };
      if ("vehicleId" in owner) {
        const result = await prisma.vehicleReconciliationPending.updateMany({
          where: { vehicleId: owner.vehicleId, fieldKey, status: "open" },
          data });
        return result.count > 0;
      }
      const result = await prisma.customerReconciliationPending.updateMany({
        where: { customerId: owner.customerId, fieldKey, status: "open" },
        data });
      return result.count > 0;
    },
    async listOpenPendingsForUnit(unitId) {
      const unitCustomers = await prisma.customer.findMany({
        where: { unitId },
        select: { id: true, name: true } });
      const rows: Array<PendingRow & { customerName: string }> = [];
      for (const customer of unitCustomers) {
        for (const row of await methods.listOpenPendings(customer.id)) {
          rows.push({ ...row, customerName: customer.name ?? "" });
        }
      }
      return rows;
    },
  };
  return methods;
}
