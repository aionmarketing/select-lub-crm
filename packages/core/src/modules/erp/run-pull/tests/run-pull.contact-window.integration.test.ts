/**
 * Test design (testing-strategy) — a contact added while the pull talks to Omie survives
 *
 * SUT: the pull's two writes of a customer it read BEFORE an Omie call, over the
 *   cadastro store the pull writes through (`customers/contracts/import-from-erp`):
 *   1. the match pass (`matchUnlinkedCustomers`), which reads its candidates, lists
 *      every Omie client (slow), then links a candidate;
 *   2. the ingest (`pullOmieClients` → `ingestOmieSnapshot`), which reads the
 *      customer, calls `adapter.get`, then applies an Omie-only change.
 * Why this file exists (4B review): 4B ruling D2 made `saveCustomer` REPLACE the
 *   phone and e-mail rows, the API store's behaviour, so an Omie change to the
 *   primary phone reaches the CRM. Saving a customer read before an Omie call would
 *   then delete a contact an attendant added during that call. Two fixes make D2
 *   safe: the match pass links with `saveCustomerColumns` (the old pull store's
 *   column-only body), and the engine's Omie-only branch re-reads the customer after
 *   the provider calls and saves that fresh copy. The engine fix also closes the same
 *   window on the API's on-read resync, which has run the replacing save since
 *   before 4B.
 * Oracle: omie-sync "unlinked customers are matched by tax id or phone" and "Omie-only
 *   change is applied with sync origin" — neither touches a contact it was not about.
 * Axes: the write — match / ingest. The window is realised deterministically: the
 *   fake adapter inserts the phone row inside the Omie call itself.
 * Mutation-checked: case 1 fails with `saveCustomer` in place of
 *   `saveCustomerColumns` in `erp/run-pull/pull.ts`; case 2 fails with the
 *   Omie-only branch of `decideField` saving the caller's copy (the pre-fix body).
 *   Both fail with the added phone gone.
 * Role: the store runs every call under `module_customers`, the recorder under
 *   `module_erp`; the fake's insert is the test's own raw write, made while no store
 *   call is in flight. Both passes are scoped to this file's own customers
 *   (`MatchCandidateScope`); production matches database-wide, so an unscoped
 *   test would lock every unlinked demo customer until it rolled back.
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { createFakeOmie, emptySnapshot, type OmieSyncPort } from "../../../../kernel/clients/erp-mock.js";
import { matchUnlinkedCustomers, pullOmieClients } from "../pull.js";
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

/** The phone an attendant adds while the pull is waiting on Omie. */
const ADDED_PHONE = "11944444444";

/** Adds {@link ADDED_PHONE}, not primary, to `customerId` — the attendant's edit. */
async function addPhone(tx: DbClient, customerId: string) {
  await tx.customerPhone.create({
    data: { customerId, raw: ADDED_PHONE, normalized: ADDED_PHONE, isPrimary: false },
  });
}

async function phonesOf(tx: DbClient, customerId: string) {
  const rows = await tx.customerPhone.findMany({ where: { customerId } });
  return rows.map((row) => ({ normalized: row.normalized, isPrimary: row.isPrimary }));
}

describeWithDatabase("pull keeps a contact added while it waits on Omie", () => {
  const db = () => prisma as PrismaClient;

  it("the match pass links the candidate and keeps a phone added during the listing", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      // A tax id no other row holds, so this candidate matches and nothing else does.
      const taxId = String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 1000)).padStart(3, "0");
      const candidate = await tx.customer.create({
        data: { name: "Bruna", taxId, unitId: unit.id, origin: "manual", status: "active" },
        select: { id: true },
      });
      const omieId = `omie-match-${randomUUID().slice(0, 8)}`;
      const fake = createFakeOmie();
      fake.seed(omieId, { ...emptySnapshot(), razao_social: "Bruna", cnpj_cpf: taxId });
      // The match pass reads its candidates, THEN lists Omie: the phone lands in between.
      const adapter: OmieSyncPort = Object.assign({}, fake, {
        listPage: async (page: number, filter?: { alteredAfter?: string }) => {
          await addPhone(tx, candidate.id);
          return fake.listPage(page, filter);
        },
      });
      const store = createCadastroImportStore(createDb(tx, runInTransactionOnTx(tx)), {});

      await matchUnlinkedCustomers({
        store,
        adapter,
        errors: { record: async () => {} },
        scope: { customerIds: [candidate.id] },
      });

      const linked = await tx.customer.findUniqueOrThrow({ where: { id: candidate.id } });
      // Precondition: the candidate was actually linked, so the save under test ran.
      expect(linked.omieId).toBe(omieId);
      expect(await phonesOf(tx, candidate.id)).toEqual([
        { normalized: ADDED_PHONE, isPrimary: false },
      ]);
    }));

  it("the ingest applies Omie's new primary phone and keeps a phone added during adapter.get", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const omieId = `omie-ingest-${randomUUID().slice(0, 8)}`;
      const customer = await tx.customer.create({
        data: {
          name: "Caio",
          omieId,
          unitId: unit.id,
          origin: "OMIE_SYNC",
          status: "active",
          phones: { create: { raw: "11911111111", normalized: "11911111111", isPrimary: true } },
        },
        select: { id: true },
      });
      // In step at the old phone, so Omie's new one is an Omie-only change.
      await tx.customerFieldSync.create({
        data: {
          customerId: customer.id,
          fieldKey: "primaryPhone",
          origin: "OMIE_SYNC",
          localVersion: 1,
          externalVersion: 1,
          syncedLocalVersion: 1,
          syncedExternalVersion: 1,
          lastOmieWire: "11911111111",
        },
      });
      const fake = createFakeOmie();
      fake.seed(omieId, { ...emptySnapshot(), razao_social: "Caio", telefone: "11922222222" });
      // The ingest reads the customer, THEN calls get: the phone lands in between.
      const adapter: OmieSyncPort = Object.assign({}, fake, {
        get: async (id: string) => {
          await addPhone(tx, customer.id);
          return fake.get(id);
        },
      });
      const db = createDb(tx, runInTransactionOnTx(tx));

      await pullOmieClients({
        mode: "full",
        store: createCadastroImportStore(db, {}),
        adapter,
        sync: createSyncRunRecorder(db),
        // Caio is linked already, so no customer of this test is a match candidate.
        matchScope: { customerIds: [] },
      });

      const phones = await phonesOf(tx, customer.id);
      // Precondition: the Omie-only change was applied, so the save under test ran.
      expect(phones).toContainEqual({ normalized: "11922222222", isPrimary: true });
      expect(phones).toContainEqual({ normalized: ADDED_PHONE, isPrimary: false });
    }));
});
