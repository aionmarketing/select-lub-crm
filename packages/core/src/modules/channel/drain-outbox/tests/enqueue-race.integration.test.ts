/**
 * Test design (testing-strategy)
 *
 * SUT: channel's `enqueueOutbound` contract with `onExisting: "reconcile"` — the
 *   scheduled due tick's call — racing this slice's drain, on the real database
 *   in a rolling-back transaction, with a stubbed `EvolutionSend`.
 *
 * Ran under module role: `channel` (the contract and the drain both run on
 *   `db.tx("channel")`).
 *
 * THE RACE (adopt-modular-vertical-slices 3A, ruling Q1-A; required test). The
 * due tick and the drain used to run inside ONE worker tick, one after the other,
 * so they could not interleave. As separate jobs they can:
 *
 *   1. the due tick reads the row by its idempotency key: `queued`;
 *   2. the drain claims it, sends it, and confirms it;
 *   3. the due tick, which read the channel as down, writes `blocked` over it;
 *   4. on reconnect the due tick flips `blocked` to `queued`;
 *   5. the drain sends it AGAIN — a customer gets the same message twice.
 *
 * Step 3 is what `enqueueOutbound` closes: both reconcile writes are a
 * compare-and-set whose `where` carries the statuses the transition is allowed
 * from, so a row that moved on since the read matches nothing.
 *
 * HOW THE INTERLEAVING IS BUILT. Calls sharing one test transaction run one at a
 * time, so two real calls cannot interleave here. What step 3 depends on is only
 * that the due tick's READ is stale by the time it WRITES, so the test supplies
 * exactly that: a handle whose `outboxMessage.findUnique` answers with the row as
 * it stood before the drain ran, while every write and the re-read after it hit
 * the real row. A due tick that wrote by id without the status guard turns that
 * confirmed row `blocked` here; the guarded one leaves it alone. Mutation-checked:
 * dropping the status from the re-block's `where` fails the first case.
 *
 * Positive controls, so the guard cannot pass by never writing: the same call
 * DOES re-block a row that really is `queued`, and DOES unblock one that really
 * is `blocked` when the channel is back.
 */
import type { PrismaClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { createDb, type Db, type DbClient, type ModuleName, type RunInTransaction } from "../../../../kernel/db.js";
import {
  enqueueOutbound,
  OUTBOX_BLOCKED_DISCONNECTED,
} from "../../contracts/enqueue-outbound.js";
import { describeWithDatabase, runInTransactionOnTx, withTestTransaction } from "../../../../testing/index.js";
import { drainOnce } from "../index.js";
import { db, mockEvolution, rowOf, setup } from "./drain-outbox.fixture.js";

type OutboxRow = Awaited<ReturnType<DbClient["outboxMessage"]["findUniqueOrThrow"]>>;

/** Binds a delegate's own methods, so a proxied call keeps its `this`. */
function bound<T extends object>(target: T, key: string | symbol) {
  const value = Reflect.get(target, key) as unknown;
  return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
}

/**
 * A handle over `tx` whose `outboxMessage.findUnique` returns `stale` — the row
 * as the due tick read it — while everything else reaches the database.
 */
function staleReadDb(tx: DbClient, stale: OutboxRow): Db {
  const real = createDb(tx, runInTransactionOnTx(tx));
  const withStaleRead = (inner: DbClient): DbClient =>
    new Proxy(inner, {
      get(target, key) {
        if (key !== "outboxMessage") return bound(target, key);
        return new Proxy(target.outboxMessage, {
          get(delegate, method) {
            return method === "findUnique" ? async () => stale : bound(delegate, method);
          },
        });
      },
    });
  return {
    client: real.client,
    tx<T>(module: ModuleName, fn: (inner: DbClient) => Promise<T>, run?: RunInTransaction) {
      return real.tx(module, (inner) => fn(withStaleRead(inner)), run);
    },
  };
}

const KEY = (suffix: string) => `race-${suffix}-${Math.random().toString(36).slice(2)}`;

describeWithDatabase("enqueueOutbound racing the drain", () => {
  it("leaves a row the drain confirmed after the due tick read it exactly as the drain left it", () =>
    withTestTransaction(db() as PrismaClient, async (tx) => {
      const { conversationId, db: handle } = await setup(tx);
      const key = KEY("confirmed");
      const queued = await enqueueOutbound(handle, {
        conversationId,
        textBody: "Retorno em seis meses",
        idempotencyKey: key,
        connected: true,
        onExisting: "reconcile",
      });
      // Step 1: the due tick's read.
      const readByDueTick = await rowOf(tx, queued.id);
      expect(readByDueTick.status).toBe("queued"); // precondition
      // Step 2: the drain claims, sends and confirms.
      await drainOnce({
        db: handle,
        evolution: mockEvolution({ ok: true, externalMessageId: "prov-race", providerTimestamp: null }),
      });
      const confirmed = await rowOf(tx, queued.id);
      expect(confirmed.status).toBe("confirmed"); // precondition

      // Step 3: the due tick writes from its stale read, channel down.
      const result = await enqueueOutbound(staleReadDb(tx, readByDueTick), {
        conversationId,
        textBody: "Retorno em seis meses",
        idempotencyKey: key,
        connected: false,
        onExisting: "reconcile",
      });

      const after = await rowOf(tx, queued.id);
      expect(after.status).toBe("confirmed");
      expect(after.lastError).toBeNull();
      expect(after.externalMessageId).toBe("prov-race");
      expect(after.attemptCount).toBe(confirmed.attemptCount);
      expect(result).toMatchObject({ id: queued.id, status: "confirmed", created: false });
    }));

  it("re-blocks a row that really is queued when the channel reads down", () =>
    withTestTransaction(db() as PrismaClient, async (tx) => {
      const { conversationId, db: handle } = await setup(tx);
      const key = KEY("queued");
      const queued = await enqueueOutbound(handle, {
        conversationId,
        textBody: "oi",
        idempotencyKey: key,
        connected: true,
        onExisting: "reconcile",
      });

      const result = await enqueueOutbound(handle, {
        conversationId,
        textBody: "oi",
        idempotencyKey: key,
        connected: false,
        onExisting: "reconcile",
      });

      const row = await rowOf(tx, queued.id);
      expect(row.status).toBe("blocked");
      expect(row.lastError).toBe(OUTBOX_BLOCKED_DISCONNECTED);
      expect(result).toMatchObject({ status: "blocked", created: false });
    }));

  it("unblocks a blocked row when the channel is back", () =>
    withTestTransaction(db() as PrismaClient, async (tx) => {
      const { conversationId, db: handle } = await setup(tx);
      const key = KEY("blocked");
      const blocked = await enqueueOutbound(handle, {
        conversationId,
        textBody: "oi",
        idempotencyKey: key,
        connected: false,
        onExisting: "reconcile",
      });
      expect(blocked).toMatchObject({ status: "blocked", created: true }); // precondition

      await enqueueOutbound(handle, {
        conversationId,
        textBody: "oi",
        idempotencyKey: key,
        connected: true,
        onExisting: "reconcile",
      });

      const row = await rowOf(tx, blocked.id);
      expect(row.status).toBe("queued");
      expect(row.lastError).toBeNull();
    }));
});
