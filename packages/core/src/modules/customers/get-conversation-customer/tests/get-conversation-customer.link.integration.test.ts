/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/api/src/http/cadastro-link.test.ts` (adopt-modular-vertical-
 * slices 4B); runs under module_customers. This file keeps that suite's
 * `resolveCadastroCustomer` and `refreshLinkedCustomer` cases, called through
 * the re-exports on this slice's `index.ts`, assertions unchanged. Its
 * `vehicleFromCreate` case went to
 * create-customer-vehicle/tests/create-customer-vehicle.new-vehicle.integration.test.ts.
 *
 * NOT MECHANICAL: `resolveCadastroCustomer` used to take the conversations and
 *   cadastro stores; it now takes the database handle and reads the conversation
 *   through the conversations module's `getCadastroLink` contract. So the
 *   `stores()` helper — and with it the injected channel probe and this test's
 *   own `instanceName`, which existed only because the deleted
 *   `createPrismaConversationsStore` was constructed — is gone: the calls pass
 *   `createDb(tx, runInTransactionOnTx(tx))`, and the conversations are built
 *   with the harness seeds (`seedConnection`/`seedConversation`), as before.
 *
 * SUT: `resolveCadastroCustomer` and `refreshLinkedCustomer`, over the real
 *   `getCadastroLink` contract and the cadastro store.
 *
 * Setup: `withTestTransaction` against the worktree's Postgres; the database
 *   handle is built on the transaction client with `runInTransactionOnTx`,
 *   because every store call opens its own `customers` transaction and Prisma
 *   forbids nesting. `createFakeOmie` stays: it doubles the external ERP, not a
 *   store, and is passed to `refreshLinkedCustomer` directly.
 *
 *   **Every row read here is created here.** A package-scoped `pnpm --filter
 *   <pkg> test` skips the root vitest globalSetup that migrates and seeds, so
 *   demo-seed tables are empty under that invocation while a worktree database
 *   and a root CI run are both full. Every row read here is created here, so
 *   the file is correct under either.
 *
 * WHAT ONLY HELD ON THE FAKE
 *
 *   The decisive one is `getCadastroLink`. On the real contract it is
 *   `findFirst({ where: { id, whatsappConnection: { unitId } } })` — the
 *   conversation reaches its unit through the connection — and it returns
 *   `phone: conversation.chatKey`. The memory conversations store held a flat
 *   `unitId` on the row, so "the conversation is not in the unit" was a
 *   property comparison rather than a join, and a conversation could be in a
 *   unit with no connection at all, which the schema forbids
 *   (`whatsappConnectionId` is a required FK). The other-unit fallback `it`
 *   below now crosses two real units whose conversations hang off two real
 *   connections.
 *
 *   Second: the fake's customer store accepted `seedCustomer({ unitId })` with
 *   no unit row behind it. `Customer.unitId` is a real FK, and
 *   `findCustomerByPhone` joins `customer: { unitId }`, so the phone fallback
 *   is now exercised through the same join production uses rather than an
 *   object field.
 *
 * Oracle: cadastro / conversas — a conversation without a unit link is
 *   missing; a linked conversation resolves the customer by id when that
 *   customer belongs to the unit, otherwise by phone. omie-sync — opening
 *   cadastro refreshes a linked customer; failure degrades to the stored row;
 *   no Omie call when omieId is null.
 *
 * Axes
 *   A1 conversation link — missing / present
 *   A2 customerId on link — set in-unit / set other-unit / null
 *   A3 phone match — hit / miss
 *   A5 refresh — linked drift / failReads / omieId null
 *   (A4, the create body, moved with the `vehicleFromCreate` case.)
 *
 * Outputs
 *   O1 { missing: true }
 *   O2 { missing: false, customer }
 *   O3 { missing: false, customer: null }
 *
 * Sampled-cell
 *   unknown conversation | A1 miss        | O1 | phone lookup
 *   id in unit           | A2 in-unit     | O2 | phone used instead
 *   id other unit        | A2 other + A3  | O2 phone-hit | other-unit customer
 *   id null + phone hit  | A2 null A3 hit | O2 | missing
 *   id null + phone miss | A3 miss        | O3 | invented customer
 *   linked refresh drift | A5 linked      | name Maria | stored Ana
 *   failReads degrade    | A5 fail        | stored Ana | throw
 *   omieId null skip     | A5 skip        | getCalls 0 | adapter.get
 *
 * Decision / branch map (internal/conversation-customer.ts, internal/resync-from-erp.ts)
 *   !link                         T unknown it; F linked its
 *   link.customerId               T id its; F phone-only its
 *   byId && byId.unitId === unit  T in-unit it; F other-unit it
 *   !customer                     T phone fallback its; F in-unit skips phone
 *   refresh !omieId               T skip it; F drift/fail its
 *   refresh ingest throw          T failReads it; F drift it
 *
 * Out of scope, with reason
 *   - The cadastro HTTP routes themselves: each slice's own tests.
 *   - The conflict engine's version arithmetic: `cadastro.live` and the
 *     update-customer engine suite.
 */
import { expect, it } from "vitest";
import { createFakeOmie, emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
import { emptySync } from "../../contracts/cadastro-store/port.js";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import type { DbClient } from "@select-lub/core/db";
import { createDb } from "../../../../kernel/db.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { createCadastroStore } from "../../contracts/cadastro-store/index.js";
import { refreshLinkedCustomer, resolveCadastroCustomer } from "../index.js";

/** A customer in a unit, with optional phone and Omie linkage. */
async function addCustomer(
  tx: DbClient,
  input: {
    unitId: string | null;
    name: string | null;
    omieId?: string | null;
    phone?: { raw: string; normalized: string };
  },
) {
  return tx.customer.create({
    data: {
      name: input.name,
      unitId: input.unitId,
      omieId: input.omieId ?? null,
      origin: "crm",
      status: "active",
      ...(input.phone
        ? { phones: { create: { ...input.phone, isPrimary: true } } }
        : {}),
    },
    select: { id: true, name: true, unitId: true, omieId: true },
  });
}

/** One unit with one connection, and the database handle on the transaction. */
async function setup(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  return { unit, connection, db: createDb(tx, runInTransactionOnTx(tx)) };
}

describeWithDatabase("cadastro-link helpers (real adapters)", () => {
  const db = () => prisma as PrismaClient;

  it("returns missing when the conversation is not in the unit", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, db: handle } = await setup(tx);

      const resolved = await resolveCadastroCustomer(handle, unit.id, "missing");

      expect(resolved).toEqual({ missing: true });
    }));

  it("returns missing for a real conversation belonging to another unit's connection", () =>
    withTestTransaction(db(), async (tx) => {
      // Sharper than the id-that-does-not-exist case above, and unwritable on
      // the fake: the conversation EXISTS, and only the join through its
      // connection puts it outside this unit.
      const { unit, db: handle } = await setup(tx);
      const other = await seedUnit(tx);
      const foreignConnection = await seedConnection(tx, { unitId: other.id });
      const foreign = await seedConversation(tx, { connectionId: foreignConnection.id });

      // Precondition: the row is really there, so `missing` below is the scope
      // rejecting it rather than the lookup finding nothing.
      expect(await tx.conversation.findUnique({ where: { id: foreign.id }, select: { id: true } })).not
        .toBeNull();

      expect(await resolveCadastroCustomer(handle, unit.id, foreign.id)).toEqual({
        missing: true,
      });
      // And it resolves for the unit that does own the connection.
      expect(await resolveCadastroCustomer(handle, other.id, foreign.id)).toEqual({
        missing: false,
        customer: null,
      });
    }));

  it("returns the customer by id when the link and unit match", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, connection, db: handle } = await setup(tx);
      const customer = await addCustomer(tx, { unitId: unit.id, name: "Ana" });
      const conversation = await seedConversation(tx, {
        connectionId: connection.id,
        chatKey: "5511999990000",
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { customerId: customer.id },
      });

      const resolved = await resolveCadastroCustomer(handle, unit.id, conversation.id);

      expect(resolved).toEqual({
        missing: false,
        customer: expect.objectContaining({ id: customer.id }),
      });
    }));

  it("falls back to phone when the linked customer belongs to another unit", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, connection, db: handle } = await setup(tx);
      const otherUnit = await seedUnit(tx);
      const linkedElsewhere = await addCustomer(tx, { unitId: otherUnit.id, name: "Outra" });
      const phoneHit = await addCustomer(tx, {
        unitId: unit.id,
        name: "Ana",
        phone: { raw: "11999990000", normalized: "5511999990000" },
      });
      const conversation = await seedConversation(tx, {
        connectionId: connection.id,
        chatKey: "5511999990000",
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { customerId: linkedElsewhere.id },
      });

      const resolved = await resolveCadastroCustomer(handle, unit.id, conversation.id);

      expect(resolved).toEqual({
        missing: false,
        customer: expect.objectContaining({ id: phoneHit.id }),
      });
      // Named explicitly: the other-unit customer must not be the answer, which
      // is the branch the `byId.unitId === unitId` guard exists for.
      expect(resolved).not.toEqual({
        missing: false,
        customer: expect.objectContaining({ id: linkedElsewhere.id }),
      });
    }));

  it("looks up by phone when the conversation has no customer id", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, connection, db: handle } = await setup(tx);
      const conversation = await seedConversation(tx, {
        connectionId: connection.id,
        chatKey: "5511888880000",
      });

      // Precondition: no customer carries this phone in this unit, so the null
      // below is a miss rather than a lookup that was never reached.
      expect(
        await tx.customerPhone.count({
          where: { normalized: "5511888880000", customer: { unitId: unit.id } },
        }),
      ).toBe(0);

      const resolved = await resolveCadastroCustomer(handle, unit.id, conversation.id);

      expect(resolved).toEqual({ missing: false, customer: null });
    }));
});

describeWithDatabase("refreshLinkedCustomer (real cadastro adapter)", () => {
  const db = () => prisma as PrismaClient;

  /** A customer whose `name` is already in sync with Omie at version 1. */
  async function linkedAtVersionOne(tx: DbClient, unitId: string) {
    const customer = await addCustomer(tx, { unitId, name: "Ana", omieId: "omie-1" });
    await tx.customerFieldSync.create({
      data: {
        customerId: customer.id,
        ...emptySync("name"),
        localVersion: 1,
        externalVersion: 1,
        syncedLocalVersion: 1,
        syncedExternalVersion: 1,
        lastOmieWire: "Ana",
      },
    });
    return customer;
  }

  it("applies an Omie-only name change for a linked customer", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const cadastro = createCadastroStore(createDb(tx, runInTransactionOnTx(tx)));
      const fake = createFakeOmie();
      const customer = await linkedAtVersionOne(tx, unit.id);
      fake.seed("omie-1", { ...emptySnapshot(), razao_social: "Ana" });
      fake.seed("omie-1", { ...emptySnapshot(), razao_social: "Maria" });

      const refreshed = await refreshLinkedCustomer(
        cadastro,
        fake,
        await cadastro.getCustomer(customer.id),
      );

      expect(refreshed?.name).toBe("Maria");
      // The change reached Postgres, not only the returned object.
      expect(
        (await tx.customer.findUnique({ where: { id: customer.id }, select: { name: true } }))?.name,
      ).toBe("Maria");
    }));

  it("returns the stored customer when Omie reads fail", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const cadastro = createCadastroStore(createDb(tx, runInTransactionOnTx(tx)));
      const fake = createFakeOmie();
      const customer = await linkedAtVersionOne(tx, unit.id);
      fake.seed("omie-1", { ...emptySnapshot(), razao_social: "Ana" });
      fake.failReads();

      const refreshed = await refreshLinkedCustomer(
        cadastro,
        fake,
        await cadastro.getCustomer(customer.id),
      );

      expect(refreshed?.name).toBe("Ana");
    }));

  it("does not call Omie when omieId is null", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const cadastro = createCadastroStore(createDb(tx, runInTransactionOnTx(tx)));
      const fake = createFakeOmie();
      const customer = await addCustomer(tx, { unitId: unit.id, name: "Ana", omieId: null });
      let getCalls = 0;
      const originalGet = fake.get.bind(fake);
      fake.get = async (omieId) => {
        getCalls += 1;
        return originalGet(omieId);
      };

      const refreshed = await refreshLinkedCustomer(
        cadastro,
        fake,
        await cadastro.getCustomer(customer.id),
      );

      expect(refreshed?.name).toBe("Ana");
      expect(getCalls).toBe(0);
    }));
});
