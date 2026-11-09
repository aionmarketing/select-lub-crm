/**
 * Test design (testing-strategy)
 *
 * Moved from apps/worker/src/ingest/retry.test.ts (adopt-modular-vertical-slices 4A),
 * all cases, assertions unchanged. Ran under module roles: `conversations` for
 * conversation/message, `channel` (through its contracts) for webhook_event and
 * whatsapp_connection. Two mechanical changes: the store is `createIngestStore`
 * over the test transaction, and the insert hook the old cases counted is the
 * `conversations/message-received` event, counted at the same point.
 *
 * Setup: `retryPendingEvents` + `canonicalizeEvent` against the real Prisma
 * ingest store on the worktree database, inside a rolling-back test transaction
 * (`withTestTransaction`). WEBHOOK_RETRY_MAX_ATTEMPTS = 5. STALE_RECEIVED_MS =
 * 60_000. The poison cases keep the real store and override only
 * `runConversationMessageTransaction`, so the retry bookkeeping under test
 * (`incrementAttemptCount`, `markEvent`, `listRetryableEvents`) is the adapter's
 * and only the injected failure is synthetic.
 *
 * Spec rule (openspec/specs/channel/whatsapp-channel/spec.md — Bounded webhook-event
 * retry): a legal failed upsert becomes one message. A poison payload parks as
 * failed_permanent after 5 attempts. Stale received events are retried; fresh
 * received events are left for the in-flight webhook.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (route-tests-on-real-database, D10). Two.
 *
 *   1. Every message assertion was an absolute count or index over the fake's map
 *      (`store.messages()).toHaveLength(1)`, `store.messages()[0]?.…`,
 *      `store.conversations()[0]?.whatsappConnectionId`). On the real database
 *      those range over the pristine base and the demo seed as well, and the index
 *      asserts an ordering the adapter never promises. Each is rewritten as a
 *      lookup or a count scoped to this test's own connection (design.md D9).
 *
 *   2. `listRetryableEvents` has no tenancy predicate at all on the adapter — it
 *      selects every failed or stale-received event in the table under the attempt
 *      bound. Against the fake that was indistinguishable from "the events this
 *      test made", because the fake's map held nothing else. It is a real property
 *      of the unit: a heartbeat retry is global, which is what makes the stale-vs-
 *      fresh partition meaningful rather than a per-test detail. The migrated file
 *      states it, and the stale/fresh case now asserts on the events by id rather
 *      than on "the first message in the store".
 *
 * Both poison-path cases (`failed` after one throw, `failed_permanent` after five)
 * behaved identically on the adapter and on the fake; no behavioural divergence
 * surfaced in the retry bookkeeping itself.
 *
 * Partitions (one numbered group = event statuses the spec treats the same):
 *
 *   P1 VALID   — failed + legal upsert → processed, 1 message
 *   P2 INVALID — insert always throws: after 5 canonicalize attempts
 *                → failed_permanent; a further retryPendingEvents pass
 *                does not increment attemptCount
 *   P3 VALID   — createdAt now − 61_000 (stale received) → processed
 *   P4 VALID   — createdAt now (fresh received) → still received
 *   P5 VALID   — insert throws Error → log contains error.message, not body
 *   P6 INVALID — insert throws a non-Error → log contains "unknown"
 *
 * Output partitions:
 *   O1 — processed + 1 message (P1/P3)
 *   O2 — failed_permanent, 0 messages (P2)
 *   O3 — still received (P4)
 *   O4 — log line with the Error message, no message body (P5)
 *   O5 — log line with "unknown", no thrown value text (P6)
 *
 * Limits (boundary value analysis):
 *   WEBHOOK_RETRY_MAX_ATTEMPTS = 5: attemptCount 5 is the last retry,
 *   then permanent. A 6th pass must not keep incrementing.
 *   attemptCount 4 is still inside the budget (P1 covers retryable).
 *   STALE_RECEIVED_MS = 60_000. Example stale is 61_000 (cutoff + 1s).
 *   Fresh is just-created (well below 60s). 59_000 is not asserted.
 *
 * Map from each `it` to a partition:
 *
 *   processes a failed valid upsert into one message — P1
 *   marks a poison event failed after the first throw — catch F of the
 *     attemptCount >= max ternary
 *   logs the thrown Error message when canonicalize fails — P5, D9 T
 *   logs unknown when canonicalize throws a non-Error — P6, D9 F
 *   marks a poison event failed_permanent after 5 attempts and leaves it
 *     on a further pass — P2
 *   retries a stale received event and leaves a fresh received event untouched
 *     — P3 + P4
 *
 * What would make a test fail:
 *   poison event still `received` after 5 failures
 *   recovered upsert inserting two messages
 *   fresh event processed on the same pass as the stale one
 *
 * Not in this file: a dedicated 59_000 vs 60_000 clock case.
 * canonicalize.ts catch failed vs failed_permanent is sampled here (P1/P2).
 * D9 catch `error instanceof Error` — T in P5, F in P6.
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import type { DbClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  seedConnection,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { expect, it } from "vitest";
import { canonicalizeEvent, persistRawEvent, retryPendingEvents } from "../index.js";
import { WEBHOOK_RETRY_MAX_ATTEMPTS } from "../../../channel/contracts/index.js";
import { upsertPayload } from "../../../../testing/index.js";
import { ingestStoreOn } from "./ingest.fixture.js";
import type { IngestStore as Persistence } from "../index.js";

const db = () => prisma as PrismaClient;

/**
 * Seeds a unit and a connection and builds the real ingest store on `tx`.
 *
 * @param tx - The test transaction.
 * @returns The connection row and the store built on `tx`.
 */
async function setup(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  const store = ingestStoreOn(tx);
  return { connection, store };
}

/**
 * The real store with only the conversation write replaced by a throw.
 *
 * Everything the retry logic itself reads and writes stays the adapter's.
 *
 * @param store - The real ingest store.
 * @param thrown - The value to throw from `runConversationMessageTransaction`.
 * @returns A store that fails every canonical message insert.
 */
function poison(store: Persistence, thrown: unknown): Persistence {
  return {
    ...store,
    runConversationMessageTransaction: async () => {
      throw thrown;
    },
  };
}

/**
 * Counts this connection's messages. A delta, never the whole table.
 *
 * @param tx - The test transaction.
 * @param connectionId - The connection to scope to.
 * @returns The row count for that connection.
 */
function messageCount(tx: DbClient, connectionId: string) {
  return tx.message.count({ where: { conversation: { whatsappConnectionId: connectionId } } });
}

describeWithDatabase("bounded retry", () => {
  it("processes a failed valid upsert into one message", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const { id } = await persistRawEvent(
        store,
        upsertPayload({ instance: connection.instanceName }),
      );
      await store.markEvent(id, "failed");
      expect(await messageCount(tx, connection.id)).toBe(0); // precondition

      await retryPendingEvents(store);

      expect(await messageCount(tx, connection.id)).toBe(1);
      expect((await store.getEvent(id))?.status).toBe("processed");
      // The conversation is reached by its own key, not by index into the table.
      const conversations = await tx.conversation.findMany({
        where: { whatsappConnectionId: connection.id },
      });
      expect(conversations).toHaveLength(1);
    }));

  it("marks a poison event failed after the first throw", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const failing = poison(store, new Error("poison"));
      const { id } = await persistRawEvent(
        failing,
        upsertPayload({ instance: connection.instanceName }),
      );

      await canonicalizeEvent(failing, id);

      expect((await store.getEvent(id))?.status).toBe("failed");
      expect((await store.getEvent(id))?.attemptCount).toBe(1);
      expect(await messageCount(tx, connection.id)).toBe(0);
    }));

  it("logs the thrown Error message when canonicalize fails", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const failing = poison(store, new Error("poison"));
      const logs: string[] = [];
      const { id } = await persistRawEvent(
        failing,
        upsertPayload({ instance: connection.instanceName }),
      );

      await canonicalizeEvent(
        failing,
        id,
        (message) => {
          logs.push(message);
        },
      );

      expect(logs).toEqual(["canonicalize failed poison"]);
      expect((await store.getEvent(id))?.status).toBe("failed");
    }));

  it("logs unknown when canonicalize throws a non-Error", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const failing = poison(store, "not-an-error");
      const logs: string[] = [];
      const { id } = await persistRawEvent(
        failing,
        upsertPayload({ instance: connection.instanceName }),
      );

      await canonicalizeEvent(
        failing,
        id,
        (message) => {
          logs.push(message);
        },
      );

      expect(logs).toEqual(["canonicalize failed unknown"]);
      expect((await store.getEvent(id))?.status).toBe("failed");
    }));

  it("marks a poison event failed_permanent after 5 attempts and leaves it on a further pass", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const failing = poison(store, new Error("poison"));
      const { id } = await persistRawEvent(
        failing,
        upsertPayload({ instance: connection.instanceName }),
      );

      for (let i = 0; i < WEBHOOK_RETRY_MAX_ATTEMPTS; i += 1) {
        await canonicalizeEvent(failing, id);
      }

      expect((await store.getEvent(id))?.status).toBe("failed_permanent");
      expect((await store.getEvent(id))?.attemptCount).toBe(WEBHOOK_RETRY_MAX_ATTEMPTS);

      await retryPendingEvents(failing);

      expect((await store.getEvent(id))?.status).toBe("failed_permanent");
      expect((await store.getEvent(id))?.attemptCount).toBe(WEBHOOK_RETRY_MAX_ATTEMPTS);
      expect(await messageCount(tx, connection.id)).toBe(0);
    }));

  it("retries a stale received event and leaves a fresh received event untouched", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const stale = await persistRawEvent(
        store,
        upsertPayload({ instance: connection.instanceName, id: "STALE" }),
      );
      const fresh = await persistRawEvent(
        store,
        upsertPayload({
          instance: connection.instanceName,
          id: "FRESH",
          remoteJid: "5511888888888@s.whatsapp.net",
        }),
      );
      await tx.webhookEvent.update({
        where: { id: stale.id },
        data: { createdAt: new Date(Date.now() - 61_000) },
      });
      expect((await store.getEvent(stale.id))?.status).toBe("received"); // precondition
      expect((await store.getEvent(fresh.id))?.status).toBe("received");

      await retryPendingEvents(store);

      expect((await store.getEvent(stale.id))?.status).toBe("processed");
      expect((await store.getEvent(fresh.id))?.status).toBe("received");
      // Exactly the stale event's message landed, identified by provider id
      // rather than by position in the table.
      const messages = await tx.message.findMany({
        where: { conversation: { whatsappConnectionId: connection.id } },
        select: { externalMessageId: true },
      });
      expect(messages.map((row) => row.externalMessageId)).toEqual(["STALE"]);
    }));
});
