/**
 * Test design (testing-strategy) — prefill / retry-prefill,
 * `POST /conversations/:id/prefill/retry`
 *
 * Moved from `apps/api/src/cadastro.prefill.test.ts`, its three retry cases,
 * assertions unchanged. The route is mounted alone through `buildSliceApp`.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (carried over)
 *   The in-flight count reads `cadastro_prefill_job` itself. A partial unique
 *   index (`UNIQUE (conversation_id) WHERE status IN ('queued','running')`)
 *   would refuse a second in-flight insert outright, so "does not insert a
 *   second job" is also a 200 rather than a constraint error.
 *
 * Oracle: assistive-cadastro-prefill design.md D6; prefill-switch — retry is
 *   refused while the extraction switch is off.
 *
 * Axes: A6 extractEnabled — on / off; in flight — yes / no
 *
 * Sampled-cell
 *   retry after failed, switch on  | 200 extracting, 1 job in flight | no job
 *   retry with one queued          | 200, still 1 in flight          | 2 in flight
 *   retry while switch off         | 409, 0 in flight                | 200 queued
 *
 * Decision map: D10 retry in flight — T already queued; F after failed.
 *   D15 retry while off — T 409; F D10.
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { prefillSuggestionSchema } from "../../contracts/http.js";
import { expect, it } from "vitest";
import { createDb, type Db, type DbClient, type ModuleName, type RunInTransaction } from "../../../../kernel/db.js";
import { registerSlice } from "../../../../kernel/http.js";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { route } from "../index.js";

const PHONE = "11988887777";

const db = () => prisma as PrismaClient;

/** A conversation with one job in `jobStatus`, and an attendant of its unit. */
async function seedPrefill(tx: DbClient, jobStatus: "queued" | "failed") {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id, chatKey: PHONE });
  await tx.cadastroPrefillJob.create({ data: { conversationId: conversation.id, status: jobStatus } });
  const user = await seedUser(tx, { units: [unit.id] });
  return { unitId: unit.id, userId: user.id, conversationId: conversation.id };
}

function switchOn(tx: DbClient, conversationId: string) {
  return tx.conversation.update({ where: { id: conversationId }, data: { prefillExtractEnabled: true } });
}

async function retry(
  tx: DbClient,
  s: { unitId: string; userId: string; conversationId: string },
  handle: Db = createDb(tx, runInTransactionOnTx(tx)),
) {
  const app = await buildSliceApp({
    db: handle,
    plugin: (app) => registerSlice(app, "prefill", "retry-prefill", route),
    caller: { unitId: s.unitId, userId: s.userId },
  });
  try {
    return await app.inject({ method: "POST", url: `/conversations/${s.conversationId}/prefill/retry` });
  } finally {
    await app.close();
  }
}

/** Queued or running jobs for a conversation. */
function inFlightJobs(tx: DbClient, conversationId: string) {
  return tx.cadastroPrefillJob.findMany({
    where: { conversationId, status: { in: ["queued", "running"] } },
    select: { id: true, status: true },
  });
}

describeWithDatabase("POST /conversations/:id/prefill/retry", () => {
  it("queues a job on retry when none is in flight", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, "failed");
      await switchOn(tx, s.conversationId);

      const response = await retry(tx, s);

      expect(response.statusCode).toBe(200);
      expect(prefillSuggestionSchema.parse(response.json()).status).toBe("extracting");
      expect(await inFlightJobs(tx, s.conversationId)).toHaveLength(1);
    }));

  it("does not insert a second job when retry finds one in flight", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, "queued");
      await switchOn(tx, s.conversationId);

      const response = await retry(tx, s);

      expect(response.statusCode).toBe(200);
      expect(await inFlightJobs(tx, s.conversationId)).toHaveLength(1);
    }));

  it("returns 409 and does not enqueue when retry is posted while the switch is off", () =>
    withTestTransaction(db(), async (tx) => {
      const s = await seedPrefill(tx, "failed");

      const response = await retry(tx, s);

      expect(response.statusCode).toBe(409);
      expect(await inFlightJobs(tx, s.conversationId)).toHaveLength(0);
    }));

  it("answers a double press whose insert loses the in-flight index as already running, not a 500", () =>
    withTestTransaction(db(), async (tx) => {
      // The other press's job is already queued, but this request's in-flight
      // reads are stale (both presses looked before either inserted), so it
      // inserts too and the partial unique index refuses it: a real P2002.
      const s = await seedPrefill(tx, "queued");
      await switchOn(tx, s.conversationId);

      const response = await retry(tx, s, staleUntilInsert(tx));

      expect(response.statusCode).toBe(200);
      expect(prefillSuggestionSchema.parse(response.json()).status).toBe("extracting");
      expect(await inFlightJobs(tx, s.conversationId)).toHaveLength(1);
    }));
});

/** Binds a delegate's own methods, so a proxied call keeps its `this`. */
function bound<T extends object>(target: T, key: string | symbol) {
  const value = Reflect.get(target, key) as unknown;
  return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
}

/**
 * A handle whose in-flight job reads answer "none" until the first job insert,
 * then read the database: the view of a request that looked before the other
 * press inserted.
 */
function staleUntilInsert(tx: DbClient): Db {
  const real = createDb(tx, runInTransactionOnTx(tx));
  let inserted = false;
  const wrap = (inner: DbClient): DbClient =>
    new Proxy(inner, {
      get(target, key) {
        if (key !== "cadastroPrefillJob") return bound(target, key);
        return new Proxy(target.cadastroPrefillJob, {
          get(delegate, method) {
            if (method === "create") {
              return (...args: unknown[]) => {
                inserted = true;
                return (delegate.create as (...a: unknown[]) => unknown).apply(delegate, args);
              };
            }
            if (method === "findFirst") {
              return async (args: { where?: { status?: unknown } }) => {
                const inFlightRead = typeof args?.where?.status === "object";
                if (!inserted && inFlightRead) return null;
                return delegate.findFirst(args as never);
              };
            }
            return bound(delegate, method);
          },
        });
      },
    });
  return {
    client: real.client,
    tx<T>(module: ModuleName, fn: (inner: DbClient) => Promise<T>, run?: RunInTransaction) {
      return real.tx(module, (inner) => fn(wrap(inner)), run);
    },
  };
}
