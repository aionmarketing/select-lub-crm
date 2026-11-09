/**
 * Per-field sync versions: the rows the engine's four-cell policy reads and writes.
 *
 * Moved from `apps/api/src/cadastro/prisma.ts` with bodies unchanged. Writes
 * `customer_field_sync` and `vehicle_field_sync`. `vehicle_field_sync` is also written by
 * the plate-origin store (`plate-origin.ts`, beside this file) with its own origin
 * vocabulary (`PLACA`/`CRM`); both are kept exactly as they were.
 */
import type { DbClient } from "@select-lub/core/db";
import type { CadastroStore } from "./port.js";
import { toSync } from "./rows.js";

/** The field-sync methods of the cadastro store. */
export type FieldSyncMethods = Pick<
  CadastroStore,
  "getSync" | "bumpLocal" | "bumpExternal" | "markSynced" | "recordAttempt"
>;

/**
 * The field-sync methods, over one client.
 *
 * @param prisma - The `customers` transaction the call runs in.
 * @returns The methods, with their bodies as the API's store had them.
 */
export function fieldSyncMethods(prisma: DbClient): FieldSyncMethods {
  return {
    async getSync(owner, fieldKey) {
      if ("vehicleId" in owner) {
        const row = await prisma.vehicleFieldSync.findUnique({
          where: { vehicleId_fieldKey: { vehicleId: owner.vehicleId, fieldKey } } });
        return row ? toSync(row) : null;
      }
      const row = await prisma.customerFieldSync.findUnique({
        where: { customerId_fieldKey: { customerId: owner.customerId, fieldKey } } });
      return row ? toSync(row) : null;
    },
    async bumpLocal(owner, fieldKey, changedBy) {
      if ("vehicleId" in owner) {
        await prisma.vehicleFieldSync.upsert({
          where: { vehicleId_fieldKey: { vehicleId: owner.vehicleId, fieldKey } },
          create: {
            vehicleId: owner.vehicleId,
            fieldKey,
            origin: "CRM",
            localVersion: 1,
            changedBy },
          update: {
            localVersion: { increment: 1 },
            origin: "CRM",
            changedBy } });
        return;
      }
      await prisma.customerFieldSync.upsert({
        where: { customerId_fieldKey: { customerId: owner.customerId, fieldKey } },
        create: {
          customerId: owner.customerId,
          fieldKey,
          origin: "CRM",
          localVersion: 1,
          changedBy },
        update: {
          localVersion: { increment: 1 },
          origin: "CRM",
          changedBy } });
    },
    async bumpExternal(owner, fieldKey, wire) {
      if ("vehicleId" in owner) {
        await prisma.vehicleFieldSync.upsert({
          where: { vehicleId_fieldKey: { vehicleId: owner.vehicleId, fieldKey } },
          create: {
            vehicleId: owner.vehicleId,
            fieldKey,
            origin: "OMIE_SYNC",
            externalVersion: 1,
            lastOmieWire: wire,
            changedBy: "OMIE_SYNC" },
          update: {
            externalVersion: { increment: 1 },
            lastOmieWire: wire,
            origin: "OMIE_SYNC",
            changedBy: "OMIE_SYNC" } });
        return;
      }
      await prisma.customerFieldSync.upsert({
        where: { customerId_fieldKey: { customerId: owner.customerId, fieldKey } },
        create: {
          customerId: owner.customerId,
          fieldKey,
          origin: "OMIE_SYNC",
          externalVersion: 1,
          lastOmieWire: wire,
          changedBy: "OMIE_SYNC" },
        update: {
          externalVersion: { increment: 1 },
          lastOmieWire: wire,
          origin: "OMIE_SYNC",
          changedBy: "OMIE_SYNC" } });
    },
    async markSynced(owner, fieldKey, expected, patch) {
      const data = {
        origin: patch.origin,
        syncedLocalVersion: expected.localVersion,
        syncedExternalVersion: expected.externalVersion,
        changedBy: patch.changedBy,
        ...(patch.lastOmieWire !== undefined ? { lastOmieWire: patch.lastOmieWire } : {}) };
      const versionWhere = {
        fieldKey,
        localVersion: expected.localVersion,
        externalVersion: expected.externalVersion };
      if ("vehicleId" in owner) {
        const result = await prisma.vehicleFieldSync.updateMany({
          where: { vehicleId: owner.vehicleId, ...versionWhere },
          data });
        return result.count === 1;
      }
      const result = await prisma.customerFieldSync.updateMany({
        where: { customerId: owner.customerId, ...versionWhere },
        data });
      return result.count === 1;
    },
    async recordAttempt(owner, fieldKey, outcome) {
      const data = {
        lastAttemptedAt: new Date(),
        lastResult: outcome.result,
        lastError: outcome.error };
      if ("vehicleId" in owner) {
        await prisma.vehicleFieldSync.updateMany({
          where: { vehicleId: owner.vehicleId, fieldKey },
          data });
        return;
      }
      await prisma.customerFieldSync.updateMany({
        where: { customerId: owner.customerId, fieldKey },
        data });
    },
  };
}
