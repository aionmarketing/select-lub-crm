/**
 * Test design (testing-strategy) — an Omie change to the primary phone reaches the CRM
 *
 * SUT: `pullOmieClients` over the cadastro store the pull writes through
 *   (`customers/contracts/import-from-erp`), on a customer already linked to Omie,
 *   whose `primaryPhone` Omie changed and the CRM did not (an Omie-only change).
 * Why this file exists (4B ruling D2): the pull's store used to be its own copy,
 *   whose `saveCustomer` wrote the customer's columns and never its phones. The
 *   engine applies an Omie-only change with `setBusinessValue` then `saveCustomer`,
 *   so an Omie change to the shared `primaryPhone` (or `primaryEmail`) was dropped
 *   silently. 4B merged the two stores into one, whose `saveCustomer` replaces
 *   phones and emails as the API's store always did — a behaviour FIX of the pull.
 * Oracle: omie-sync "Omie-only change is applied with sync origin"; the phone is a
 *   shared field, so it is applied like any other.
 * Axes: the phone Omie holds — unchanged (control) / changed.
 * Mutation-checked: with the old pull store's `saveCustomer` body (columns only),
 *   the changed case fails with the old phone still primary.
 * Role: the store runs every call under `module_customers`, the recorder under
 *   `module_erp`. The pull's match pass is scoped to no customer (the customer
 *   here is linked); production matches database-wide, so an unscoped test would
 *   lock every unlinked demo customer until it rolled back.
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { createFakeOmie, emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
import { pullOmieClients } from "../pull.js";
import { expect, it } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { createCadastroImportStore } from "../../../customers/contracts/import-from-erp.js";
import { createSyncRunRecorder } from "../../contracts/record-sync-run.js";

const OLD_PHONE = "11911111111";
const NEW_PHONE = "11922222222";

/**
 * A customer linked to Omie, its primary phone in step with Omie, and the fake
 * Omie holding `omiePhone` for it.
 */
async function linkedCustomer(tx: DbClient, omiePhone: string) {
  const unit = await seedUnit(tx);
  const omieId = `omie-phone-${randomUUID().slice(0, 8)}`;
  const customer = await tx.customer.create({
    data: {
      name: "Ana",
      omieId,
      unitId: unit.id,
      origin: "OMIE_SYNC",
      status: "active",
      phones: { create: { raw: OLD_PHONE, normalized: OLD_PHONE, isPrimary: true } },
    },
    select: { id: true },
  });
  // In step: both versions synced at the phone the CRM holds, so a new Omie value
  // is an Omie-only change the pull applies.
  await tx.customerFieldSync.create({
    data: {
      customerId: customer.id,
      fieldKey: "primaryPhone",
      origin: "OMIE_SYNC",
      localVersion: 1,
      externalVersion: 1,
      syncedLocalVersion: 1,
      syncedExternalVersion: 1,
      lastOmieWire: OLD_PHONE,
    },
  });
  const fake = createFakeOmie();
  fake.seed(omieId, { ...emptySnapshot(), razao_social: "Ana", telefone: omiePhone });
  return { customerId: customer.id, fake };
}

/** Pulls through the stores `runPull` builds. */
async function pull(tx: DbClient, fake: ReturnType<typeof createFakeOmie>) {
  const db = createDb(tx, runInTransactionOnTx(tx));
  await pullOmieClients({
    mode: "full",
    store: createCadastroImportStore(db, {}),
    adapter: fake,
    sync: createSyncRunRecorder(db),
    // The customer is linked already, so no customer of these tests is a match candidate.
    matchScope: { customerIds: [] },
  });
}

async function primaryPhone(tx: DbClient, customerId: string) {
  const rows = await tx.customerPhone.findMany({ where: { customerId, isPrimary: true } });
  return rows.map((row) => row.normalized);
}

describeWithDatabase("pull applies an Omie change to the primary phone", () => {
  const db = () => prisma as PrismaClient;

  it("leaves the phone alone when Omie holds the same one (control)", () =>
    withTestTransaction(db(), async (tx) => {
      const { customerId, fake } = await linkedCustomer(tx, OLD_PHONE);

      await pull(tx, fake);

      expect(await primaryPhone(tx, customerId)).toEqual([OLD_PHONE]);
    }));

  it("replaces the CRM's primary phone with the one Omie changed", () =>
    withTestTransaction(db(), async (tx) => {
      const { customerId, fake } = await linkedCustomer(tx, NEW_PHONE);

      await pull(tx, fake);

      expect(await primaryPhone(tx, customerId)).toEqual([NEW_PHONE]);
      const sync = await tx.customerFieldSync.findUniqueOrThrow({
        where: { customerId_fieldKey: { customerId, fieldKey: "primaryPhone" } },
      });
      expect(sync.lastOmieWire).toBe(NEW_PHONE);
      expect(sync.origin).toBe("OMIE_SYNC");
    }));
});
