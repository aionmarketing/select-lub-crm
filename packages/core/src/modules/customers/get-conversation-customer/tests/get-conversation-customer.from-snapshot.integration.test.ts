/**
 * Test design (testing-strategy)
 *
 * Exercises `customers/contracts/from-snapshot` (`customerFieldsFromSnapshot`,
 * `nameFromRazaoSocial`, `retainStoredName`) and the snapshot ingest path of the real
 * cadastro store, `createPrismaCadastroStore` in `apps/api/src/cadastro/prisma.ts`.
 * Relocated from `packages/omie/src/from-snapshot.test.ts`: `packages/db` depends on
 * `packages/omie`, so the Prisma adapter cannot live in the Omie package (design D6).
 *
 * Moved from `apps/api/src/cadastro/omie/from-snapshot.test.ts`
 * (adopt-modular-vertical-slices 4B): the store is now `createCadastroStore(db)`
 * and runs every call under `module_customers`.
 *
 * Setup: the three pure functions need nothing. The `upsertByOmieId` suite runs
 * inside `withTestTransaction`, against the real adapter, and rolls back.
 *
 * Fake-only assertion surfaced: the in-memory store's `upsertByOmieId` built the
 * customer from `customerFieldsFromSnapshot` alone and never touched contact rows,
 * so a snapshot's `telefone` and `email` were silently dropped and nothing noticed.
 * The real adapter replaces `customerPhone` and `customerEmail` on every upsert.
 * That is now asserted directly ("replaces the phone and e-mail rows"), and it is a
 * behaviour the fake could not express at all.
 *
 * Also fake-only: `Customer.omieId` is `@unique` in Postgres and merely a scanned
 * field on the fake, so the fake would happily hold two customers on one Omie id.
 * Each test here uses an id unique to its run so parallel files never block on that
 * constraint while their transactions are open.
 *
 * Oracle: optional-name-one-schedule-mvp omie-sync — empty/`null`
 *   razao_social stores name null, never "Omie"; ingest of empty Omie
 *   name must not overwrite a stored CRM name.
 *
 * Axes
 *   A1 razao_social — non-empty / "" / null / whitespace
 *   A2 upsert path — create vs existing Maria
 *   A3 contact fields — snapshot carries telefone+email vs neither
 *
 * Outputs
 *   O1 name is the trimmed razão; O2 name null (not "Omie"); O3 Maria kept
 *   O4 phone and e-mail rows match the latest snapshot
 *
 * Sampled-cell
 *   non-empty razão           | A1 present A2 create | O1 | "Omie" or null
 *   empty razão               | A1 ""     A2 create | O2 | "Omie"
 *   null razão                | A1 null   A2 create | O2 | "Omie"
 *   whitespace razão          | A1 "   "  A2 create | O2 | stored spaces
 *   Maria then empty snapshot | A2 existing         | O3 | name wiped
 *   contacts then cleared     | A3 both then none   | O4 | stale rows kept
 *
 * Decision map
 *   D1 trimmed razão empty    T empty/null/whitespace its; F Ana it
 *   D2 existing non-empty + incoming null  T Maria it; F create its
 *   D3 phoneDigits !== ""     T contacts it; F cleared-contacts it
 *
 * Out of scope: engine decideField KM skip (engine.test.ts); the worker's
 * `createPrismaPullCadastroStore`, a different adapter with its own unit assignment.
 */
import { randomUUID } from "node:crypto";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { customerFieldsFromSnapshot, nameFromRazaoSocial, retainStoredName } from "../../contracts/from-snapshot.js";
import { emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
import { describe, expect, it } from "vitest";
import { createDb, type DbClient } from "../../../../kernel/db.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  withTestTransaction,
} from "../../../../testing/index.js";
import { createCadastroStore } from "../../contracts/cadastro-store/index.js";

/**
 * The cadastro store over the test's transaction; every call runs in its own
 * `db.tx("customers", …)`, so under `module_customers`.
 *
 * @param tx - The test transaction.
 * @returns The store.
 */
function storeOn(tx: DbClient) {
  return createCadastroStore(createDb(tx, runInTransactionOnTx(tx)));
}

/** Omie ids are unique in Postgres, so every test coins its own. */
function omieId(label: string): string {
  return `omie-${label}-${randomUUID().slice(0, 8)}`;
}

describe("nameFromRazaoSocial", () => {
  it("returns the trimmed razão social when it is non-empty", () => {
    expect(nameFromRazaoSocial("  Ana  ")).toBe("Ana");
  });

  it("returns null when razão social is empty", () => {
    expect(nameFromRazaoSocial("")).toBeNull();
  });

  it("returns null when razão social is missing", () => {
    expect(nameFromRazaoSocial(null)).toBeNull();
  });

  it("returns null when razão social is whitespace-only", () => {
    expect(nameFromRazaoSocial("   ")).toBeNull();
  });
});

describe("customerFieldsFromSnapshot", () => {
  it("stores null name for an empty razão social and never substitutes Omie", () => {
    const fields = customerFieldsFromSnapshot({ ...emptySnapshot(), razao_social: "" });

    expect(fields.name).toBeNull();
    expect(fields.name).not.toBe("Omie");
  });
});

describe("retainStoredName", () => {
  it("keeps Maria when the incoming Omie name is null", () => {
    expect(retainStoredName("Maria", null)).toBe("Maria");
  });

  it("uses the incoming name when Omie sends a new razão social", () => {
    expect(retainStoredName("Maria", "João")).toBe("João");
  });
});

describeWithDatabase("upsertByOmieId on the real cadastro store", () => {
  const db = () => prisma as PrismaClient;

  it("creates a customer with null name from an empty razão social", () =>
    withTestTransaction(db(), async (tx) => {
      const store = storeOn(tx);
      const id = omieId("empty");
      expect(await tx.customer.findUnique({ where: { omieId: id } })).toBeNull();

      const created = await store.upsertByOmieId({
        omieId: id,
        snapshot: { ...emptySnapshot(), razao_social: "" },
      });

      expect(created.name).toBeNull();
      expect(created.name).not.toBe("Omie");
      const row = await tx.customer.findUniqueOrThrow({ where: { omieId: id } });
      expect(row.name).toBeNull();
      expect(row.origin).toBe("OMIE_SYNC");
    }));

  it("does not wipe Maria when a later snapshot has an empty razão social", () =>
    withTestTransaction(db(), async (tx) => {
      const store = storeOn(tx);
      const id = omieId("maria");
      const first = await store.upsertByOmieId({
        omieId: id,
        snapshot: { ...emptySnapshot(), razao_social: "Maria" },
      });
      expect(first.name).toBe("Maria");

      const updated = await store.upsertByOmieId({
        omieId: id,
        snapshot: { ...emptySnapshot(), razao_social: "" },
      });

      expect(updated.name).toBe("Maria");
      expect((await tx.customer.findUniqueOrThrow({ where: { omieId: id } })).name).toBe("Maria");
    }));

  it("replaces the phone and e-mail rows with the latest snapshot's contacts", () =>
    withTestTransaction(db(), async (tx) => {
      const store = storeOn(tx);
      const id = omieId("contacts");

      const created = await store.upsertByOmieId({
        omieId: id,
        snapshot: {
          ...emptySnapshot(),
          razao_social: "Ana",
          telefone: "(19) 99999-1111",
          email: "Ana@Example.com",
        },
      });

      expect(created.phones.map((phone) => phone.normalized)).toEqual(["19999991111"]);
      expect(created.emails.map((mail) => mail.normalized)).toEqual(["ana@example.com"]);

      const cleared = await store.upsertByOmieId({
        omieId: id,
        snapshot: { ...emptySnapshot(), razao_social: "Ana" },
      });

      expect(cleared.phones).toEqual([]);
      expect(cleared.emails).toEqual([]);
      expect(await tx.customerPhone.count({ where: { customerId: created.id } })).toBe(0);
      expect(await tx.customerEmail.count({ where: { customerId: created.id } })).toBe(0);
    }));
});
