/**
 * Test design (testing-strategy) — erp/drain-outbox and the enqueue-write contract
 *
 * SUT: `drainErpOutbox(db, erp, { now, limit })` over rows queued by
 *   `enqueueErpWrite(db, write)`, on the real database inside the rollback
 *   harness. The ERP is a stub port that records each `put` and answers as told.
 * Oracle: design D7 (erp is the only thing that talks to the ERP; drain-outbox
 *   pushes) and 3A.3 (`erp_outbox` sized to the per-field put). The outcomes are
 *   this slice's own decisions, stated in its header: accepted → sent; a field
 *   rejected → failed at once; the call threw → retried with a doubling delay,
 *   failed after the fifth attempt; a failure writes an `integration_error` keyed
 *   by the row id.
 *
 * Axes
 *   A1 put outcome — accepted / rejected key / throws
 *   A2 attempt — first / last allowed
 *   A3 row state before the tick — pending due / pending not yet due / sending
 *      stale / sending fresh
 *   A4 enqueue key — none / new / repeated
 *   A5 batch — rows ≤ limit / rows > limit
 *
 * Sampled cells
 *   accepted, first attempt            | A1 ok     | sent, put called with the row's values
 *   rejected key                       | A1 reject | failed, error not retryable
 *   throws, first attempt              | A1 throw  | pending, due later, error retryable
 *   throws, fifth attempt              | A2 last   | failed, error not retryable
 *   retried row at the same instant    | A3 not due| not claimed again
 *   stale / fresh sending rows         | A3        | stale reclaimed as an attempt, fresh left
 *   reclaimed on its last attempt, ×5  | A2 × A3   | failed, never pushed, error not retryable
 *   push outlives its claim            | A3        | re-claimed and sent; the late result is stale
 *   repeated idempotency key           | A4        | one row, second call created=false
 *   three rows, limit two              | A5        | the two oldest claimed
 *
 * The compare-and-set in `record()` is pinned by holding one push open while two
 *   later ticks reclaim and re-send the row, then releasing it: the row keeps the
 *   later tick's result.
 * W2-C12 is pinned directly: the stub `put` asserts that no transaction is open
 *   while it runs, by counting the `Db`'s open `tx` calls.
 * Scope: a drain claims due rows database-wide, and CI's database is seeded (the
 *   demo seed writes one `sent` row). Every case that drains first asserts that no
 *   row it did not create is claimable, then that none of those rows changed.
 * Role: every write goes through `db.tx("erp", …)`; a recorder `Db` confirms the
 *   drain asks for no other module.
 * Out of scope: registration (the job is exported, not registered — W3-C2) and
 *   the ERP adapter itself (the kernel `erp-mock` tests).
 */
import { randomUUID } from "node:crypto";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import type { OmieAdapter, OmiePutResult } from "../../../../kernel/clients/erp-mock.js";
import { expect, it } from "vitest";
import type { ErpPort } from "../../../../kernel/clients/erp.js";
import {
  createDb,
  type Db,
  type ModuleName,
  type RunInTransaction,
} from "../../../../kernel/db.js";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  withTestTransaction,
} from "../../../../testing/index.js";
import { enqueueErpWrite, type ErpWrite } from "../../contracts/enqueue-write.js";
import {
  DRAIN_ERP_OUTBOX_EVERY_MS,
  ERP_OUTBOX_CLAIM_EXPIRED,
  ERP_OUTBOX_CLAIM_TIMEOUT_MS,
  ERP_OUTBOX_MAX_ATTEMPTS,
  drainErpOutbox,
  job,
  retryDelayMs,
} from "../index.js";

// Far in the future on purpose: rows are stamped with the DATABASE clock (the
// `next_attempt_at` default is now()), and a claim asks `next_attempt_at <= NOW`.
// A fixed NOW near today stops every row being due once the wall clock passes it
// (it did, at 2026-09-24 12:00 UTC). Every other date here is relative to NOW.
const NOW = new Date("2099-01-01T12:00:00.000Z");

/** A `Db` over the test transaction that counts open transactions and the modules asked for. */
function trackedDb(tx: DbClient) {
  const real = createDb(tx, runInTransactionOnTx(tx));
  const state = { open: 0, modules: [] as ModuleName[] };
  const db: Db = {
    client: real.client,
    async tx<T>(module: ModuleName, fn: (inner: DbClient) => Promise<T>, run?: RunInTransaction) {
      state.modules.push(module);
      state.open += 1;
      try {
        return await real.tx(module, fn, run);
      } finally {
        state.open -= 1;
      }
    },
  };
  return { db, state };
}

type Answer = OmiePutResult | Error;

/** An ERP port whose `put` records its arguments and answers from a script. */
function stubErp(answers: Answer[], state?: { open: number }) {
  const calls: Array<{ erpRecordId: string; fields: unknown; integrationCode?: string }> = [];
  const openDuringPut: number[] = [];
  const adapter: OmieAdapter = {
    async get() {
      return null;
    },
    async put(erpRecordId, fields, integrationCode) {
      calls.push({ erpRecordId, fields, integrationCode });
      if (state) openDuringPut.push(state.open);
      const answer = answers.shift() ?? { failedKeys: [] };
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const erp: ErpPort = { adapter };
  return { erp, calls, openDuringPut };
}

function write(overrides: Partial<ErpWrite> = {}): ErpWrite {
  return {
    entity: "customer",
    entityId: `cus-${randomUUID().slice(0, 8)}`,
    erpRecordId: `omie-${randomUUID().slice(0, 8)}`,
    integrationCode: "crm-id-1",
    fields: { name: "Maria Souza" },
    versions: { name: { localVersion: 2, externalVersion: 1 } },
    ...overrides,
  };
}

function row(tx: DbClient, id: string) {
  return tx.erpOutbox.findUniqueOrThrow({ where: { id } });
}

/**
 * Snapshots the rows this test did not create — on a seeded database, the demo
 * seed's — and asserts none is claimable, since a drain claims database-wide.
 *
 * @returns A check that none of those rows changed.
 */
async function foreignRows(tx: DbClient): Promise<() => Promise<void>> {
  const rows = await tx.erpOutbox.findMany({ orderBy: { id: "asc" } });
  expect(rows.filter((r) => r.status === "pending" || r.status === "sending")).toEqual([]);
  const ids = rows.map((r) => r.id);
  return async () => {
    expect(await tx.erpOutbox.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } })).toEqual(rows);
  };
}

function errorsFor(tx: DbClient, id: string) {
  return tx.integrationError.findMany({ where: { correlationId: id } });
}

function itInTx(name: string, fn: (tx: DbClient) => Promise<void>) {
  it(name, () => withTestTransaction(prisma as PrismaClient, fn));
}

describeWithDatabase("drainErpOutbox", () => {
  itInTx("pushes a queued write and marks it sent, with no transaction open during the push", async (tx) => {
    const untouched = await foreignRows(tx);
    const { db, state } = trackedDb(tx);
    const queued = await enqueueErpWrite(db, write({ erpRecordId: "omie-77", integrationCode: "cus-crm-77" }));
    const { erp, calls, openDuringPut } = stubErp([{ failedKeys: [] }], state);

    const result = await drainErpOutbox(db, erp, { now: NOW });

    expect(result).toMatchObject({ claimed: 1, sent: 1, retried: 0, failed: 0 });
    expect(calls).toEqual([
      { erpRecordId: "omie-77", fields: { name: "Maria Souza" }, integrationCode: "cus-crm-77" },
    ]);
    expect(openDuringPut).toEqual([0]);
    const sent = await row(tx, queued.id);
    expect(sent.status).toBe("sent");
    expect(sent.sentAt?.toISOString()).toBe(NOW.toISOString());
    expect(sent.attemptCount).toBe(1);
    expect(await errorsFor(tx, queued.id)).toEqual([]);
    expect(new Set(state.modules)).toEqual(new Set(["erp"]));
    await untouched();
  });

  itInTx("fails a write the ERP rejects at once, recording a non-retryable error", async (tx) => {
    const untouched = await foreignRows(tx);
    const { db } = trackedDb(tx);
    const queued = await enqueueErpWrite(db, write());
    const { erp } = stubErp([{ failedKeys: ["name"], reasons: { name: "razao_social invalida" } }]);

    const result = await drainErpOutbox(db, erp, { now: NOW });

    expect(result).toMatchObject({ claimed: 1, sent: 0, retried: 0, failed: 1 });
    const failed = await row(tx, queued.id);
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toBe("name: razao_social invalida");
    const errors = await errorsFor(tx, queued.id);
    expect(errors.map((e) => [e.code, e.retryable])).toEqual([["erp_put_rejected", false]]);
    await untouched();
  });

  itInTx("puts a write that threw back in the queue for later, and does not claim it again now", async (tx) => {
    const untouched = await foreignRows(tx);
    const { db } = trackedDb(tx);
    const queued = await enqueueErpWrite(db, write());
    const { erp, calls } = stubErp([new Error("omie_429")]);

    const first = await drainErpOutbox(db, erp, { now: NOW });
    const again = await drainErpOutbox(db, erp, { now: NOW });

    expect(first).toMatchObject({ claimed: 1, retried: 1 });
    expect(again.claimed).toBe(0);
    expect(calls).toHaveLength(1);
    const retried = await row(tx, queued.id);
    expect(retried.status).toBe("pending");
    expect(retried.attemptCount).toBe(1);
    expect(retried.lastError).toBe("omie_429");
    expect(retried.nextAttemptAt.getTime()).toBe(NOW.getTime() + retryDelayMs(1));
    const errors = await errorsFor(tx, queued.id);
    expect(errors.map((e) => [e.code, e.retryable])).toEqual([["erp_put_failed", true]]);
    await untouched();
  });

  itInTx("fails a write that throws on its last allowed attempt", async (tx) => {
    const untouched = await foreignRows(tx);
    const { db } = trackedDb(tx);
    const queued = await enqueueErpWrite(db, write());
    await tx.erpOutbox.update({
      where: { id: queued.id },
      data: { attemptCount: ERP_OUTBOX_MAX_ATTEMPTS - 1 },
    });
    const { erp } = stubErp([new Error("omie_unavailable")]);

    const result = await drainErpOutbox(db, erp, { now: NOW });

    expect(result).toMatchObject({ retried: 0, failed: 1 });
    const failed = await row(tx, queued.id);
    expect(failed.status).toBe("failed");
    expect(failed.attemptCount).toBe(ERP_OUTBOX_MAX_ATTEMPTS);
    const errors = await errorsFor(tx, queued.id);
    expect(errors.map((e) => [e.code, e.retryable])).toEqual([["erp_put_failed", false]]);
    await untouched();
  });

  itInTx("reclaims a write stuck in sending past the timeout and leaves a fresh one alone", async (tx) => {
    const untouched = await foreignRows(tx);
    const { db } = trackedDb(tx);
    const stale = await enqueueErpWrite(db, write());
    const fresh = await enqueueErpWrite(db, write());
    await tx.erpOutbox.update({
      where: { id: stale.id },
      data: { status: "sending", claimedAt: new Date(NOW.getTime() - ERP_OUTBOX_CLAIM_TIMEOUT_MS - 1) },
    });
    await tx.erpOutbox.update({
      where: { id: fresh.id },
      data: { status: "sending", claimedAt: new Date(NOW.getTime() - 1_000) },
    });
    const { erp, calls } = stubErp([{ failedKeys: [] }]);

    const result = await drainErpOutbox(db, erp, { now: NOW });

    // The reclaim is the row's first attempt: back to pending, due after the
    // first retry delay, so this tick does not push it.
    expect(result).toMatchObject({ reclaimed: 1, claimed: 0, failed: 0 });
    expect(calls).toHaveLength(0);
    const reclaimed = await row(tx, stale.id);
    expect(reclaimed.status).toBe("pending");
    expect(reclaimed.attemptCount).toBe(1);
    expect(reclaimed.lastError).toBe(ERP_OUTBOX_CLAIM_EXPIRED);
    expect(reclaimed.nextAttemptAt.getTime()).toBe(NOW.getTime() + retryDelayMs(1));
    const errors = await errorsFor(tx, stale.id);
    expect(errors.map((e) => [e.code, e.retryable])).toEqual([["erp_put_claim_expired", true]]);
    expect((await row(tx, fresh.id)).status).toBe("sending");
    await untouched();
  });

  itInTx("fails a write reclaimed as often as the attempt limit, without pushing it", async (tx) => {
    const untouched = await foreignRows(tx);
    const { db } = trackedDb(tx);
    const queued = await enqueueErpWrite(db, write());
    const { erp, calls } = stubErp([]);
    const stuckSince = new Date(NOW.getTime() - ERP_OUTBOX_CLAIM_TIMEOUT_MS - 1);

    // A put that hangs every time: each tick finds the row still `sending`.
    const results = [];
    for (let i = 0; i < ERP_OUTBOX_MAX_ATTEMPTS; i += 1) {
      await tx.erpOutbox.update({
        where: { id: queued.id },
        data: { status: "sending", claimedAt: stuckSince },
      });
      results.push(await drainErpOutbox(db, erp, { now: NOW }));
    }

    expect(results.map((r) => r.reclaimed)).toEqual(Array(ERP_OUTBOX_MAX_ATTEMPTS).fill(1));
    expect(results.at(-1)?.failed).toBe(1);
    expect(calls).toHaveLength(0);
    const failed = await row(tx, queued.id);
    expect(failed.status).toBe("failed");
    expect(failed.attemptCount).toBe(ERP_OUTBOX_MAX_ATTEMPTS);
    const errors = await errorsFor(tx, queued.id);
    expect(errors).toHaveLength(ERP_OUTBOX_MAX_ATTEMPTS);
    expect(errors.filter((e) => !e.retryable)).toHaveLength(1);
    await untouched();
  });

  itInTx("keeps a later tick's result when a push that outlived its claim reports back", async (tx) => {
    const untouched = await foreignRows(tx);
    const { db } = trackedDb(tx);
    const queued = await enqueueErpWrite(db, write());
    let release: (answer: OmiePutResult) => void = () => undefined;
    let started: () => void = () => undefined;
    const pushStarted = new Promise<void>((resolve) => (started = resolve));
    const slow: ErpPort = {
      adapter: {
        async get() {
          return null;
        },
        put() {
          started();
          return new Promise<OmiePutResult>((resolve) => (release = resolve));
        },
      },
    };
    // Tick A claims the row and its push hangs.
    const tickA = drainErpOutbox(db, slow, { now: NOW });
    await pushStarted;

    // Tick B, past the claim window, reclaims it; tick C, past the retry delay,
    // claims it again and pushes successfully.
    const tB = new Date(NOW.getTime() + ERP_OUTBOX_CLAIM_TIMEOUT_MS + 1);
    const tC = new Date(tB.getTime() + retryDelayMs(1));
    expect(await drainErpOutbox(db, stubErp([]).erp, { now: tB })).toMatchObject({ reclaimed: 1 });
    expect(await drainErpOutbox(db, stubErp([]).erp, { now: tC })).toMatchObject({ claimed: 1, sent: 1 });
    const afterC = await row(tx, queued.id);

    // Tick A's push finally reports a rejection: it must change nothing.
    release({ failedKeys: ["name"], reasons: { name: "late" } });
    expect(await tickA).toMatchObject({ claimed: 1, stale: 1, sent: 0, failed: 0 });

    const final = await row(tx, queued.id);
    expect(final).toEqual(afterC);
    expect(final.status).toBe("sent");
    expect(final.sentAt?.toISOString()).toBe(tC.toISOString());
    const codes = (await errorsFor(tx, queued.id)).map((e) => e.code);
    expect(codes).toEqual(["erp_put_claim_expired"]);
    await untouched();
  });

  itInTx("claims at most the batch limit, oldest first", async (tx) => {
    const untouched = await foreignRows(tx);
    const { db } = trackedDb(tx);
    const ids: string[] = [];
    for (const [i, entityId] of ["first", "second", "third"].entries()) {
      const queued = await enqueueErpWrite(db, write({ entityId }));
      await tx.erpOutbox.update({
        where: { id: queued.id },
        data: { createdAt: new Date(NOW.getTime() - 60_000 + i * 1_000) },
      });
      ids.push(queued.id);
    }
    // Force the plan that once claimed 3 of limit 2: the LIMIT subquery on the
    // inner side of a nested loop, rescanned per row (see claimDue). The rows sit
    // oldest first, which is the order that lets each rescan reach one further.
    // SET LOCAL lasts until this test's transaction rolls back.
    await tx.$executeRaw`SET LOCAL plan_cache_mode = force_generic_plan`;
    await tx.$executeRaw`SET LOCAL enable_material = off`;
    await tx.$executeRaw`SET LOCAL enable_hashjoin = off`;
    await tx.$executeRaw`SET LOCAL enable_mergejoin = off`;
    const { erp } = stubErp([]);

    const result = await drainErpOutbox(db, erp, { now: NOW, limit: 2 });

    expect(result).toMatchObject({ claimed: 2, sent: 2 });
    const statuses = await Promise.all(ids.map(async (id) => (await row(tx, id)).status));
    expect(statuses).toEqual(["sent", "sent", "pending"]);
    await untouched();
  });

  itInTx("queues one row per idempotency key however often it is enqueued", async (tx) => {
    const { db } = trackedDb(tx);
    const key = `customer:${randomUUID()}:name:v2`;

    const first = await enqueueErpWrite(db, write({ idempotencyKey: key }));
    const second = await enqueueErpWrite(db, write({ idempotencyKey: key }));

    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, status: "pending", created: false });
    expect(await tx.erpOutbox.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it("declares the drain as the erp/drain-outbox job", () => {
    const db = createDb(prisma as PrismaClient);
    const declared = job({ db, erp: stubErp([]).erp });

    expect(declared.name).toBe("erp/drain-outbox");
    expect(declared.everyMs).toBe(DRAIN_ERP_OUTBOX_EVERY_MS);
    expect(job({ db, erp: stubErp([]).erp, everyMs: 1_234 }).everyMs).toBe(1_234);
  });
});
