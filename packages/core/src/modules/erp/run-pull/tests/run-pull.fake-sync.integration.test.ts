/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/worker/src/omie/fake-sync.test.ts` (adopt-modular-vertical-slices 3A.3), 10 cases,
 * assertions unchanged. Roles: the cadastro store runs each call in
 * `db.tx("customers")` and the sync-run recorder in `db.tx("erp")`, so every
 * write here happens under `module_customers` or `module_erp`.
 *
 * Exercises the kernel's `erp-mock/fake` (`createFakeOmie`) and its `pull`
 * module (`pullOmieClients`, `matchUnlinkedCustomers`) against the real stores
 * production pulls with: `createCadastroImportStore` (customers contract) and
 * `createSyncRunRecorder` (erp contract). Relocated first from
 * `packages/omie/src/fake-sync.test.ts`: `packages/db` depends on `packages/omie`,
 * so the Prisma adapters cannot live in the Omie package (design D6).
 *
 * Setup: createFakeOmie() + both real stores on a rolled-back transaction.
 * fetch is stubbed to prove no Omie network.
 *
 * Fake-only assertions surfaced (three):
 *
 *  1. The dual-change it built TWO cadastro stores holding the SAME `omieId`
 *     ("omie-1") at once — one to show the raw-upsert clobber, one to show the
 *     engine opening a pending instead. `Customer.omie_id` is `@unique` in
 *     Postgres, so that is not a state the system can ever be in; the fake's
 *     `upsertByOmieId` merely scanned a Map and never enforced it. The two
 *     halves now use distinct Omie ids, which is what the comparison actually
 *     needed — the contrast is between the two write paths, not between two
 *     customers sharing an identity.
 *  2. `createMemorySyncRunStore` exposed `runs()` and `errors()`; the real
 *     sync-run store implemented both as `return []`, so `sync.runs()[1]` and
 *     `errors.errors()[0]` asserted nothing about the adapter under test. Both
 *     inspectors have since been deleted from the port (#106). They
 *     now read `syncExecution` and `integrationError` back through the
 *     transaction, by returned run id and by `correlationId`.
 *  3. `listUnlinkedMatchCandidates` is database-wide in production, so the
 *     worktree's own unlinked customers were matched too and the fake gained rows
 *     this test never seeded; assertions are deltas over seeded ids (D9). Since
 *     the cleanup after wave 5 every call is scoped to this file's own customers
 *     (`MatchCandidateScope`), which also stopped the files locking each other.
 *
 * Oracle: complete-omie-integration omie-sync —
 *   Pull and match flows are exercisable without credentials;
 *   Initial load dedupes by Omie id;
 *   Match or create without merge;
 *   Incremental pull is idempotent;
 *   Omie-only change is applied with sync origin;
 *   Refresh does not clobber an un-pushed CRM edit;
 *   First link may upsert directly.
 *
 * Axes
 *   A1 source — fake listPage / incluir (no fetch)
 *   A2 load — first full / second full same id / incremental replay
 *   A3 match — unique phone / zero hits incluir / two tax hits
 *   A4 ingest — first link upsert / already-linked ingest
 *   A5 conflict — Omie-only / dual-change vs raw upsert
 *
 * Outputs: O1 one CRM row; O2 omieId set; O3 omieId null + error;
 *   O4 incluir fake-${crmId}; O5 origin OMIE_SYNC localVersion unchanged;
 *   O6 open pending neither value changes; O7 raw upsert clobbers
 *
 * Sampled-cell
 *   pull+match against fake, no fetch     | A1        | O1 | fetch called
 *   second full same omie id              | A2 second | O1 | two rows
 *   unique phone links                    | A3 phone  | O2 | omieId null
 *   zero match inclui fake-crm id         | A3 zero   | O4 | incluir skipped
 *   two tax hits stay unlinked            | A3 two    | O3 | omieId set
 *   incremental twice                     | A2 replay | O1 | second row
 *   Omie-only name via pull               | A5 omie   | O5 | origin CRM / local++
 *   dual-change via pull                  | A5 dual   | O6 | clobber / no pending
 *   raw upsert still clobbers             | A5 raw    | O7 | postalCode unchanged
 *   first link upserts                    | A4 first  | O1 | ingest without upsert
 *
 * Decision / branch map (fake.ts + pull.ts apply)
 *   listPage alteredAfter set     T incremental second; F full / first incremental
 *   listPage page < 1             named unsampled (port is 1-based; callers start at 1)
 *   incluir existing id           T second incluir same code; F first incluir
 *   findCustomerByOmieId          T Omie-only / dual; F first-link / second-full
 *   putThrows                     F these cases; T adapter.test / engine failPuts
 *
 * Out of scope: HTTP retry; group 4 OS import; mock opt-in (task 3.4).
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { createFakeOmie, emptySnapshot } from "../../../../kernel/clients/erp-mock.js";
import { emptySync } from "../../../customers/contracts/cadastro-store/port.js";
import { matchUnlinkedCustomers, pullOmieClients } from "../pull.js";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../../../../kernel/db.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { createCadastroImportStore } from "../../../customers/contracts/import-from-erp.js";
import { createSyncRunRecorder } from "../../contracts/record-sync-run.js";

/** A pull whose test created no unlinked customer matches nothing: production's database-wide pass, scoped to none. */
const NO_CANDIDATES = { customerIds: [] };

/** Omie ids are unique in Postgres, so every test coins its own. */
function omieId(label: string): string {
  return `omie-${label}-${randomUUID().slice(0, 8)}`;
}

function synced(fieldKey: "name" | "postalCode", wire: string) {
  return {
    ...emptySync(fieldKey),
    localVersion: 1,
    externalVersion: 1,
    syncedLocalVersion: 1,
    syncedExternalVersion: 1,
    lastOmieWire: wire,
    origin: "CRM" as const,
  };
}

/** Both real stores, bound to the test's transaction. */
function stores(tx: DbClient) {
  const db = createDb(tx, runInTransactionOnTx(tx));
  return {
    store: createCadastroImportStore(db, {}),
    sync: createSyncRunRecorder(db),
  };
}

async function withFetchGuard<T>(run: () => Promise<T>): Promise<T> {
  const fetchSpy = vi.fn();
  const previous = globalThis.fetch;
  globalThis.fetch = fetchSpy as typeof fetch;
  try {
    const result = await run();
    expect(fetchSpy).not.toHaveBeenCalled();
    return result;
  } finally {
    globalThis.fetch = previous;
  }
}

/** One unlinked CRM customer, optionally with a primary phone or a tax id. */
async function seedCustomer(
  tx: DbClient,
  input: {
    name: string;
    taxId?: string;
    phone?: string;
    omieId?: string | null;
    postalCode?: string;
  },
) {
  const unit = await seedUnit(tx);
  return tx.customer.create({
    data: {
      name: input.name,
      omieId: input.omieId ?? null,
      taxId: input.taxId ?? null,
      postalCode: input.postalCode ?? null,
      unitId: unit.id,
      origin: "CRM",
      status: "active",
      phones: input.phone
        ? { create: { raw: input.phone, normalized: input.phone, isPrimary: true } }
        : undefined,
    },
  });
}

describe("fake OmieSyncPort", () => {
  it("pages seeded clients and assigns a deterministic incluir id without fetch", async () => {
    await withFetchGuard(async () => {
      const fake = createFakeOmie();
      fake.seed("omie-b", { ...emptySnapshot(), razao_social: "Bia" });
      fake.seed("omie-a", { ...emptySnapshot(), razao_social: "Ana" });

      const page = await fake.listPage(1);
      const created = await fake.incluir({
        codigoIntegracao: "cus-z",
        snapshot: { ...emptySnapshot(), razao_social: "Zero" },
      });
      const again = await fake.incluir({
        codigoIntegracao: "cus-z",
        snapshot: { ...emptySnapshot(), razao_social: "Ignored" },
      });
      const after = await fake.listPage(1);

      expect(page.clients.map((row) => row.omieId)).toEqual(["omie-a", "omie-b"]);
      expect(page.totalPages).toBe(1);
      expect(created.omieId).toBe("fake-cus-z");
      expect(again.omieId).toBe("fake-cus-z");
      expect(after.clients.map((row) => row.omieId)).toEqual(["fake-cus-z", "omie-a", "omie-b"]);
      expect((await fake.get("fake-cus-z"))?.razao_social).toBe("Zero");
    });
  });
});

describeWithDatabase("pull and match against the fake", () => {
  const db = () => prisma as PrismaClient;

  it("drives pullOmieClients and matchUnlinkedCustomers with no credentials and no network", () =>
    withTestTransaction(db(), async (tx) =>
      withFetchGuard(async () => {
        const { store, sync } = stores(tx);
        const pullFake = createFakeOmie();
        const listedId = omieId("listed");
        pullFake.seed(listedId, { ...emptySnapshot(), razao_social: "Listed" });
        await pullOmieClients({ matchScope: NO_CANDIDATES, mode: "full", store, adapter: pullFake, sync });

        const matchFake = createFakeOmie();
        const customer = await seedCustomer(tx, { name: "Ana", phone: "11988887777" });
        const matchId = omieId("p");
        matchFake.seed(matchId, { ...emptySnapshot(), telefone: "11988887777" });
        await matchUnlinkedCustomers({ store, adapter: matchFake, errors: sync, scope: { customerIds: [customer.id] } });

        expect(await store.findCustomerByOmieId(listedId)).not.toBeNull();
        expect((await store.getCustomer(customer.id))?.omieId).toBe(matchId);
      }),
    ));

  it("upserts by omieId so a second full load does not duplicate", () =>
    withTestTransaction(db(), async (tx) =>
      withFetchGuard(async () => {
        const { store, sync } = stores(tx);
        const fake = createFakeOmie();
        const id = omieId("1");
        fake.seed(id, { ...emptySnapshot(), razao_social: "Ana" });

        const firstRun = await pullOmieClients({ matchScope: NO_CANDIDATES, mode: "full", store, adapter: fake, sync });
        const first = await store.findCustomerByOmieId(id);
        const secondRun = await pullOmieClients({ matchScope: NO_CANDIDATES, mode: "full", store, adapter: fake, sync });

        expect(first).not.toBeNull();
        expect((await store.findCustomerByOmieId(id))?.id).toBe(first?.id);
        expect(await tx.customer.count({ where: { omieId: id } })).toBe(1);
        const rows = await tx.syncExecution.findMany({
          where: { id: { in: [firstRun.id, secondRun.id] } },
        });
        expect(rows.filter((row) => row.status === "completed")).toHaveLength(2);
      }),
    ));

  it("replays incremental pull without a second CRM row", () =>
    withTestTransaction(db(), async (tx) =>
      withFetchGuard(async () => {
        const { store, sync } = stores(tx);
        const fake = createFakeOmie();
        const id = omieId("inc");
        fake.seed(id, { ...emptySnapshot(), razao_social: "Bia" });
        const now = new Date("2026-08-31T03:00:00.000Z");

        await pullOmieClients({ matchScope: NO_CANDIDATES, mode: "incremental", store, adapter: fake, sync, now });
        const secondRun = await pullOmieClients({ matchScope: NO_CANDIDATES,
          mode: "incremental",
          store,
          adapter: fake,
          sync,
          now,
        });

        expect((await store.findCustomerByOmieId(id))?.name).toBe("Bia");
        expect(await tx.customer.count({ where: { omieId: id } })).toBe(1);
        const second = await tx.syncExecution.findUniqueOrThrow({ where: { id: secondRun.id } });
        expect(second.windowFrom?.toISOString()).toBe(now.toISOString());
      }),
    ));

  it("links an unlinked CRM customer on a unique primary phone", () =>
    withTestTransaction(db(), async (tx) =>
      withFetchGuard(async () => {
        const { store, sync } = stores(tx);
        const fake = createFakeOmie();
        const customer = await seedCustomer(tx, { name: "Ana", phone: "11988887777" });
        const id = omieId("p");
        fake.seed(id, { ...emptySnapshot(), telefone: "11988887777" });

        await matchUnlinkedCustomers({ store, adapter: fake, errors: sync, scope: { customerIds: [customer.id] } });

        expect((await store.getCustomer(customer.id))?.omieId).toBe(id);
      }),
    ));

  it("inclui with a deterministic fake id when nothing matches", () =>
    withTestTransaction(db(), async (tx) =>
      withFetchGuard(async () => {
        const { store, sync } = stores(tx);
        const fake = createFakeOmie();
        const customer = await seedCustomer(tx, { name: "Zero", taxId: "11144477735" });

        await matchUnlinkedCustomers({ store, adapter: fake, errors: sync, scope: { customerIds: [customer.id] } });

        expect((await store.getCustomer(customer.id))?.omieId).toBe(`fake-${customer.id}`);
        expect(await fake.get(`fake-${customer.id}`)).not.toBeNull();
      }),
    ));

  it("leaves omieId null when two Omie clients share the tax id", () =>
    withTestTransaction(db(), async (tx) =>
      withFetchGuard(async () => {
        const { store, sync } = stores(tx);
        const customer = await seedCustomer(tx, { name: "Dup", taxId: "11144477735" });
        const fake = createFakeOmie();
        fake.seed(omieId("a"), { ...emptySnapshot(), cnpj_cpf: "11144477735" });
        fake.seed(omieId("b"), { ...emptySnapshot(), cnpj_cpf: "111.444.777-35" });

        await matchUnlinkedCustomers({ store, adapter: fake, errors: sync, scope: { customerIds: [customer.id] } });

        expect((await store.getCustomer(customer.id))?.omieId).toBeNull();
        const recorded = await tx.integrationError.findMany({
          where: { correlationId: customer.id },
        });
        expect(recorded.map((row) => row.code)).toEqual(["omie_match_ambiguous"]);
      }),
    ));
});

describeWithDatabase("conflict-safe pull ingest", () => {
  const db = () => prisma as PrismaClient;

  it("applies an Omie-only change with origin OMIE_SYNC and does not increment the CRM version", () =>
    withTestTransaction(db(), async (tx) =>
      withFetchGuard(async () => {
        const { store, sync } = stores(tx);
        const fake = createFakeOmie();
        const id = omieId("1");
        fake.seed(id, { ...emptySnapshot(), razao_social: "Ana" });

        await pullOmieClients({ matchScope: NO_CANDIDATES, mode: "full", store, adapter: fake, sync });
        const linked = await store.findCustomerByOmieId(id);
        expect(linked).not.toBeNull();
        await tx.customerFieldSync.create({
          data: { customerId: linked!.id, ...synced("name", "Ana"), lastAttemptedAt: null },
        });
        fake.seed(id, { ...emptySnapshot(), razao_social: "Maria" });

        await pullOmieClients({ matchScope: NO_CANDIDATES, mode: "full", store, adapter: fake, sync });

        const after = await store.getCustomer(linked!.id);
        const nameSync = await store.getSync({ customerId: linked!.id }, "name");
        expect(after?.name).toBe("Maria");
        expect(nameSync?.origin).toBe("OMIE_SYNC");
        expect(nameSync?.localVersion).toBe(1);
      }),
    ));

  it("opens a pending on dual-change instead of the raw-upsert clobber", () =>
    withTestTransaction(db(), async (tx) =>
      withFetchGuard(async () => {
        const { store, sync } = stores(tx);
        const snapshotOf = (id: string) => ({
          ...emptySnapshot(),
          codigo_cliente_omie: id,
          razao_social: "Ana",
          cep: "OMIECEP1",
        });

        // Raw upsert, the path that has no conflict policy: it overwrites.
        const clobberId = omieId("clobber");
        const clobbered = await seedCustomer(tx, {
          name: "Ana",
          omieId: clobberId,
          postalCode: "CRMCEP12",
        });
        await store.upsertByOmieId({ omieId: clobberId, snapshot: snapshotOf(clobberId) });
        expect((await store.getCustomer(clobbered.id))?.postalCode).toBe("OMIECEP1");

        // The engine path, on its own customer: a distinct Omie id, because the
        // column is unique and the two customers cannot share one.
        const engineId = omieId("engine");
        const guarded = await seedCustomer(tx, {
          name: "Ana",
          omieId: engineId,
          postalCode: "CRMCEP12",
        });
        await tx.customerFieldSync.create({
          data: {
            customerId: guarded.id,
            ...synced("postalCode", "01310100"),
            lastAttemptedAt: null,
            localVersion: 2,
            syncedLocalVersion: 1,
          },
        });
        const fake = createFakeOmie();
        fake.seed(engineId, snapshotOf(engineId));

        await pullOmieClients({ matchScope: NO_CANDIDATES, mode: "full", store, adapter: fake, sync });

        expect((await store.getCustomer(guarded.id))?.postalCode).toBe("CRMCEP12");
        expect((await fake.get(engineId))?.cep).toBe("OMIECEP1");
        expect(
          (await store.getOpenPending({ customerId: guarded.id }, "postalCode"))?.status,
        ).toBe("open");
      }),
    ));

  it("first-time linking still writes through upsertByOmieId", () =>
    withTestTransaction(db(), async (tx) =>
      withFetchGuard(async () => {
        const { store, sync } = stores(tx);
        const fake = createFakeOmie();
        const id = omieId("new");
        fake.seed(id, { ...emptySnapshot(), razao_social: "Nata" });

        await pullOmieClients({ matchScope: NO_CANDIDATES, mode: "full", store, adapter: fake, sync });

        const created = await store.findCustomerByOmieId(id);
        expect(created?.name).toBe("Nata");
        expect(await store.getSync({ customerId: created!.id }, "name")).toBeNull();
      }),
    ));
});
