/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/worker/src/omie/pull.test.ts` (adopt-modular-vertical-slices 3A.3), 10 cases,
 * assertions unchanged. Roles: the cadastro store runs each call in
 * `db.tx("customers")` and the sync-run recorder in `db.tx("erp")`, so every
 * write here happens under `module_customers` or `module_erp`.
 *
 * Exercises erp's `run-pull/pull.ts` (`pullOmieClients`,
 * `matchUnlinkedCustomers`) against the real stores production pulls with:
 * `createCadastroImportStore` (customers contract) and `createSyncRunRecorder`
 * (erp contract). Relocated first from `packages/omie/src/pull.test.ts`:
 * `packages/db` depends on `packages/omie`, so the Prisma adapters cannot live in
 * the Omie package (design D6), and these are the adapters production pulls with.
 *
 * Setup: both real stores on a rolled-back transaction + a stub OmieSyncPort
 * (in-memory pages). No fetch.
 *
 * Fake-only assertions surfaced (two, and they are the reason this file was worth
 * moving):
 *
 *  1. `createMemorySyncRunStore` exposed `runs()` and `errors()` inspectors that
 *     returned everything recorded, and every assertion here indexed them
 *     absolutely (`sync.runs()[0]`, `errors.errors()[0]`). The real
 *     `createPrismaSyncRunStore` implemented both as `return []` — they were not
 *     part of the port's production job, and they have since been deleted from
 *     it (#106), because a guard built on one of them silently never fired. So every one of those assertions was
 *     reading a structure the real adapter does not maintain, and would have
 *     passed against an adapter that recorded nothing at all. They now read
 *     `syncExecution` and `integrationError` back through the transaction,
 *     keyed by the run id the call returns or by `correlationId`.
 *
 *  2. `listUnlinkedMatchCandidates` is database-wide: the fake only ever held the
 *     rows a test seeded, so `expect(adapter.incluirCalls).toEqual(["cus-z"])`
 *     looked exact. Against Postgres the worktree's existing unlinked customers
 *     are candidates too, and `pullOmieClients` calls `matchUnlinkedCustomers`
 *     itself, so the call list legitimately contains rows this test never
 *     created. Since the cleanup after wave 5 each call is scoped to the
 *     customers its test seeded (`MatchCandidateScope`), so no pull links or
 *     locks another suite's rows; production still matches database-wide, which
 *     the "keeps production's matching database-wide" case pins.
 *     Every count and list assertion here is a delta over the
 *     ids the test seeded (D9), which is also what makes it environment-
 *     independent: a freshly provisioned CI database has no demo rows and a
 *     local worktree has several, and both now pass for the same reason.
 *
 * Oracle: omie-http-adapter omie-sync —
 *   Initial load dedupes by Omie id;
 *   Match or create without merge;
 *   Incremental pull is idempotent; OS is not inferred.
 *   Omie-to-CRM application obeys the four-cell policy (first link may upsert).
 *
 * Axes
 *   A1 load — first full / second full same id / incremental replay
 *   A2 match — unique phone / zero hits / two tax hits / omieId already taken
 *   A3 OS — client pull does not invent services (stub never hits OS).
 *     `"createService" in store === false` stays: CadastroStore is not the
 *     service write path. Group 4 import writes only through
 *     `upsertServiceByOmieId` for identifiers the mock listed — see
 *     import-surfaces.test.ts (zero OS → no rows; listed id only).
 *
 * Outputs: O1 one CRM row per omieId; O2 omieId set; O3 omieId null + error;
 *   O4 incluir with CRM id; O5 SyncExecution completed; O6 no Service
 *
 * Sampled-cell
 *   second full load same omie id     | A1 second | O1 | two rows
 *   unique phone links                | A2 phone  | O2 | omieId null
 *   zero match inclui CRM id          | A2 zero   | O4 | incluir not called
 *   no usable key                     | A2 none   | no incluir, one log line | incluir on every pull
 *   one usable key (phone only)       | A2 zero   | O4 | skipped as no-key
 *   two tax hits stay unlinked        | A2 two    | O3 | omieId set or no error
 *   incremental page twice            | A1 replay | O1 | second row
 *   stub never calls OS               | A3        | O6 | osCalls > 0
 *   empty omieId skipped              | A1 skip   | O1 | written > 0
 *   already-linked unique id          | A2 taken  | O3 | merge / omieId set
 *   second list page in match         | A2 page2  | O2 | listCalls missing 2
 *
 * Decision / branch map (pull.ts)
 *   mode incremental + previous run   T incremental it (second replay has windowTo); F first incremental + full
 *   client.omieId === ""              T empty-id it; F second-full it
 *   ids.length === 1 + already linked T already-linked it; F unique phone it
 *   ids.length === 0                  T zero it; F unique/two
 *   ids.length >= 2                   T two-tax it; F unique
 *   candidates.length === 0           T second-full (all linked); F match its
 *   collectAllClients page>=2         T two-page match it; F unique-phone one page
 *   pull catch                        T listPage-throw it; F happy full
 *   findCustomerByOmieId existing     T ingest (fake-sync Omie-only / clobber);
 *     F first-link upsert (second-full it)
 *
 * Out of scope: HTTP retry (http.test.ts); vehicle/OS mapping #29.
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { emptySnapshot, type OmieListedClient, type OmieSyncPort } from "../../../../kernel/clients/erp-mock.js";
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

/** A pull whose test created no unlinked customer matches nothing: production's database-wide pass, scoped to none. */
const NO_CANDIDATES = { customerIds: [] };

/** Omie ids are unique in Postgres, so every test coins its own. */
function omieId(label: string): string {
  return `omie-${label}-${randomUUID().slice(0, 8)}`;
}

function listed(id: string, patch: Partial<OmieListedClient["snapshot"]>): OmieListedClient {
  return { omieId: id, snapshot: { ...emptySnapshot(), ...patch } };
}

function stubPort(pages: OmieListedClient[][]): OmieSyncPort & {
  listCalls: number[];
  listFilters: Array<{ alteredAfter?: string } | undefined>;
  incluirCalls: string[];
  osCalls: number;
} {
  const port = {
    listCalls: [] as number[],
    listFilters: [] as Array<{ alteredAfter?: string } | undefined>,
    incluirCalls: [] as string[],
    osCalls: 0,
    async get() {
      return null;
    },
    async put() {
      return { failedKeys: [] };
    },
    async listPage(page: number, filter?: { alteredAfter?: string }) {
      port.listCalls.push(page);
      port.listFilters.push(filter);
      const clients = pages[page - 1] ?? [];
      return { clients, page, totalPages: Math.max(pages.length, 1) };
    },
    async incluir(input: { codigoIntegracao: string }) {
      port.incluirCalls.push(input.codigoIntegracao);
      return { omieId: `new-${input.codigoIntegracao}` };
    },
  };
  return port;
}

/** Both real stores, bound to the test's transaction. */
function stores(tx: DbClient) {
  const db = createDb(tx, runInTransactionOnTx(tx));
  return {
    store: createCadastroImportStore(db, {}),
    sync: createSyncRunRecorder(db),
  };
}

/**
 * Reads back one recorded run. The port has no inspector for this: `runs()`
 * returned an empty array from the real adapter and was deleted (#106), so the
 * run is read from the table it was written to.
 */
async function runRow(tx: DbClient, id: string) {
  const row = await tx.syncExecution.findUniqueOrThrow({ where: { id } });
  return { ...row, totals: row.totals as { read: number; written: number; errors: number } };
}

/** The integration errors this test caused, identified by correlation id. */
function errorsFor(tx: DbClient, correlationId: string) {
  return tx.integrationError.findMany({ where: { correlationId }, orderBy: { createdAt: "asc" } });
}

describeWithDatabase("pullOmieClients", () => {
  const db = () => prisma as PrismaClient;

  it("upserts by omieId so a second full load does not duplicate", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, sync } = stores(tx);
      const id = omieId("1");
      const clients = [listed(id, { razao_social: "Ana" })];
      expect(await store.findCustomerByOmieId(id)).toBeNull();

      const firstRun = await pullOmieClients({ matchScope: NO_CANDIDATES, mode: "full", store, adapter: stubPort([clients]), sync });
      const first = await store.findCustomerByOmieId(id);
      const secondRun = await pullOmieClients({ matchScope: NO_CANDIDATES,
        mode: "full",
        store,
        adapter: stubPort([clients]),
        sync,
      });

      expect(first).not.toBeNull();
      expect((await store.findCustomerByOmieId(id))?.id).toBe(first?.id);
      expect(await tx.customer.count({ where: { omieId: id } })).toBe(1);
      expect((await runRow(tx, firstRun.id)).status).toBe("completed");
      expect((await runRow(tx, secondRun.id)).status).toBe("completed");
    }));

  it("replays the same incremental page without a second CRM row", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, sync } = stores(tx);
      const id = omieId("inc");
      const page = [listed(id, { razao_social: "Bia" })];
      const firstAdapter = stubPort([page]);
      const secondAdapter = stubPort([page]);
      const now = new Date("2026-08-31T03:00:00.000Z");

      const firstRun = await pullOmieClients({ matchScope: NO_CANDIDATES,
        mode: "incremental",
        store,
        adapter: firstAdapter,
        sync,
        now,
      });
      const secondRun = await pullOmieClients({ matchScope: NO_CANDIDATES,
        mode: "incremental",
        store,
        adapter: secondAdapter,
        sync,
        now,
      });

      expect((await store.findCustomerByOmieId(id))?.name).toBe("Bia");
      expect(await tx.customer.count({ where: { omieId: id } })).toBe(1);
      expect((await runRow(tx, firstRun.id)).mode).toBe("incremental");
      expect((await runRow(tx, secondRun.id)).mode).toBe("incremental");
      // The first run had no completed predecessor of its own making; the second
      // filters on the window the first closed.
      expect(secondAdapter.listFilters[0]?.alteredAfter).toBe(now.toISOString());
    }));

  it("skips a listed client whose omieId is empty", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, sync } = stores(tx);
      const adapter = stubPort([[listed("", { razao_social: "Ghost" })]]);

      const run = await pullOmieClients({ matchScope: NO_CANDIDATES, mode: "full", store, adapter, sync });

      expect(await store.findCustomerByOmieId("")).toBeNull();
      expect((await runRow(tx, run.id)).totals.written).toBe(0);
      expect(run.totals.read).toBe(1);
    }));

  it("does not invent a Service row and the stub never hits OS", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, sync } = stores(tx);
      const adapter = stubPort([[listed(omieId("os"), { razao_social: "Cris" })]]);
      const servicesBefore = await tx.service.count();

      await pullOmieClients({ matchScope: NO_CANDIDATES, mode: "full", store, adapter, sync });

      expect(adapter.osCalls).toBe(0);
      expect("createService" in store).toBe(false);
      expect(await tx.service.count()).toBe(servicesBefore);
    }));

  it("records a failed SyncExecution when listPage throws", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, sync } = stores(tx);
      const adapter = stubPort([]);
      adapter.listPage = async () => {
        throw new Error("omie_429");
      };
      const before = (await tx.syncExecution.findMany({ select: { id: true } })).map((row) => row.id);

      await expect(pullOmieClients({ matchScope: NO_CANDIDATES, mode: "full", store, adapter, sync })).rejects.toThrow(
        "omie_429",
      );

      const created = await tx.syncExecution.findMany({ where: { id: { notIn: before } } });
      expect(created).toHaveLength(1);
      expect(created[0]?.status).toBe("failed");
      const recorded = await errorsFor(tx, created[0]!.id);
      expect(recorded.map((row) => row.code)).toEqual(["omie_pull_failed"]);
      expect(recorded[0]?.message).toBe("omie_429");
    }));
});

describeWithDatabase("matchUnlinkedCustomers", () => {
  const db = () => prisma as PrismaClient;

  /** One unlinked CRM customer, optionally with a primary phone or tax id. */
  async function seedUnlinked(
    tx: DbClient,
    input: { name: string; taxId?: string; phone?: string; normalizedPhone?: string; omieId?: string },
  ) {
    const unit = await seedUnit(tx);
    return tx.customer.create({
      data: {
        name: input.name,
        omieId: input.omieId ?? null,
        taxId: input.taxId ?? null,
        unitId: unit.id,
        origin: "CRM",
        status: "active",
        phones:
          input.phone !== undefined
            ? { create: { raw: input.phone, normalized: input.normalizedPhone ?? input.phone, isPrimary: true } }
            : undefined,
      },
    });
  }

  it("links an unlinked CRM customer on a unique primary phone", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, sync } = stores(tx);
      const customer = await seedUnlinked(tx, { name: "Ana", phone: "11988887777" });
      const id = omieId("p");
      const adapter = stubPort([[listed(id, { telefone: "11988887777" })]]);
      expect((await store.getCustomer(customer.id))?.omieId).toBeNull();

      await matchUnlinkedCustomers({ store, adapter, errors: sync, scope: { customerIds: [customer.id] } });

      expect((await store.getCustomer(customer.id))?.omieId).toBe(id);
    }));

  it("inclui with codigo_integracao equal to the CRM id when nothing matches", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, sync } = stores(tx);
      const customer = await seedUnlinked(tx, { name: "Zero", taxId: "11144477735" });
      const adapter = stubPort([[]]);

      await matchUnlinkedCustomers({ store, adapter, errors: sync, scope: { customerIds: [customer.id] } });

      // A delta, not an exact list: the worktree's own unlinked customers are
      // candidates here too, which the fake could never show.
      expect(adapter.incluirCalls).toContain(customer.id);
      expect((await store.getCustomer(customer.id))?.omieId).toBe(`new-${customer.id}`);
    }));

  it("skips a candidate with no usable key: no incluir, no link, one log line naming only its id", () =>
    withTestTransaction(db(), async (tx) => {
      // apply-owner-rulings-2026-09-25 delta 2: no tax-id digits AND a primary
      // phone that normalizes to "". Before, it reached incluir on every pull.
      // Mutation-checked: without the skip, incluir is called with its id.
      const { store, sync } = stores(tx);
      const customer = await seedUnlinked(tx, { name: "Sem chave", taxId: "sem cpf", phone: "(sem)", normalizedPhone: "" });
      const adapter = stubPort([[]]);
      const lines: string[] = [];

      await matchUnlinkedCustomers({
        store,
        adapter,
        errors: sync,
        scope: { customerIds: [customer.id] },
        log: (line) => lines.push(line),
      });

      expect(adapter.incluirCalls).not.toContain(customer.id);
      expect((await store.getCustomer(customer.id))?.omieId).toBeNull();
      expect(lines).toEqual([`omie_match_no_key customer=${customer.id}`]);
      // Not an integration failure: no error row for it.
      expect(await errorsFor(tx, customer.id)).toEqual([]);
    }));

  it("still inclui a candidate with one usable key (a phone, no tax-id digits)", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, sync } = stores(tx);
      const customer = await seedUnlinked(tx, { name: "Só fone", taxId: "sem cpf", phone: "11911112222" });
      const adapter = stubPort([[]]);
      const lines: string[] = [];

      await matchUnlinkedCustomers({
        store,
        adapter,
        errors: sync,
        scope: { customerIds: [customer.id] },
        log: (line) => lines.push(line),
      });

      expect(adapter.incluirCalls).toContain(customer.id);
      expect(lines).toEqual([]);
    }));

  it("leaves omieId null and records a sanitized error when two Omie clients share the tax id", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, sync } = stores(tx);
      const customer = await seedUnlinked(tx, { name: "Dup", taxId: "11144477735" });
      const adapter = stubPort([
        [
          listed(omieId("a"), { cnpj_cpf: "11144477735" }),
          listed(omieId("b"), { cnpj_cpf: "111.444.777-35" }),
        ],
      ]);

      await matchUnlinkedCustomers({ store, adapter, errors: sync, scope: { customerIds: [customer.id] } });

      expect((await store.getCustomer(customer.id))?.omieId).toBeNull();
      const recorded = await errorsFor(tx, customer.id);
      expect(recorded.map((row) => row.code)).toEqual(["omie_match_ambiguous"]);
      expect(recorded[0]?.message).not.toContain("11144477735");
    }));

  it("pages a second ListarClientes page when matching unlinked customers", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, sync } = stores(tx);
      const customer = await seedUnlinked(tx, { name: "Page", phone: "11977776666" });
      const hit = omieId("p2");
      const adapter = stubPort([
        [listed(omieId("p1"), { telefone: "11000000000" })],
        [listed(hit, { telefone: "11977776666" })],
      ]);

      await matchUnlinkedCustomers({ store, adapter, errors: sync, scope: { customerIds: [customer.id] } });

      expect(adapter.listCalls).toEqual([1, 2]);
      expect((await store.getCustomer(customer.id))?.omieId).toBe(hit);
    }));

  it("keeps production's matching database-wide: no scope lists every candidate, a scope only its own", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, sync } = stores(tx);
      const a = await seedUnlinked(tx, { name: "Scoped", phone: "11911112222" });
      const b = await seedUnlinked(tx, { name: "Unscoped", taxId: "22233344455" });

      // The store: read-only, so it locks nothing. Unscoped reaches a customer no
      // scope named; scoped returns exactly the named one.
      const all = (await store.listUnlinkedMatchCandidates()).map((row) => row.id);
      expect(all).toEqual(expect.arrayContaining([a.id, b.id]));
      const scoped = (await store.listUnlinkedMatchCandidates({ customerIds: [a.id] })).map((row) => row.id);
      expect(scoped).toEqual([a.id]);
      // An empty scope is NO candidate, never "everything": the pull tests pass it
      // for "this test created none", and read as everything it would quietly
      // re-lock every unlinked customer while every assertion still passed.
      expect(await store.listUnlinkedMatchCandidates({ customerIds: [] })).toEqual([]);

      // The pull: called as the worker calls it, with no matchScope, it hands the
      // store no scope at all. The spy answers with no candidates, so nothing is
      // linked or written here.
      const seen: unknown[] = [];
      const spied = {
        ...store,
        listUnlinkedMatchCandidates: async (scope?: unknown) => {
          seen.push(scope);
          return [];
        },
      };
      await pullOmieClients({ mode: "full", store: spied, adapter: stubPort([[]]), sync });
      expect(seen).toEqual([undefined]);
    }));

  it("does not merge when the unique Omie id already belongs to another CRM customer", () =>
    withTestTransaction(db(), async (tx) => {
      const { store, sync } = stores(tx);
      const taken = omieId("taken");
      const old = await seedUnlinked(tx, { name: "Old", omieId: taken });
      const fresh = await seedUnlinked(tx, { name: "New", taxId: "99988877766" });
      const adapter = stubPort([[listed(taken, { cnpj_cpf: "99988877766" })]]);

      await matchUnlinkedCustomers({ store, adapter, errors: sync, scope: { customerIds: [old.id, fresh.id] } });

      expect((await store.getCustomer(fresh.id))?.omieId).toBeNull();
      expect((await store.getCustomer(old.id))?.omieId).toBe(taken);
      const recorded = await errorsFor(tx, fresh.id);
      expect(recorded.map((row) => row.code)).toEqual(["omie_match_already_linked"]);
    }));
});
