/**
 * Test design (testing-strategy) — drain-outbox, the 404 connection write
 *
 * SUT: `drainOnce` / `drainOutbox` on a send Evolution answers as the instance
 *   guard's 404 (`kind: "disconnected"`), on the real database in a rolling-back
 *   test transaction, with a stubbed `EvolutionSend`. Which 404 bodies count as
 *   `disconnected` is the client's (internal/evolution.send-outcome.test.ts).
 *
 * Oracle: whatsapp-channel, change `outbox-404-marks-disconnected` — "A 404
 *   send marks the connection disconnected": the item is blocked and the
 *   connection DISCONNECTED with last_disconnected_at, dated before the send;
 *   ordered by observation time; a failed state write does not stop the tick
 *   (review of #207). Split from drain-outbox.integration.test.ts for its line limit.
 *
 * Sampled-cell
 *   404 on a CONNECTED connection | DISCONNECTED, dated before send | not written
 *   connection.update during send | the newer state kept             | 404 overwrites it
 *   state write throws            | row blocked, next row confirmed  | tick stops
 *   refused send (control)        | state untouched                  | flipped by any failure
 */
import { expect, it } from "vitest";
import type { Db, ModuleName, RunInTransaction } from "../../../../kernel/db.js";
import { describeWithDatabase, withTestTransaction } from "../../../../testing/index.js";
import { drainOnce, drainOutbox } from "../index.js";
import { db, enqueue, mockEvolution, rowOf, setup, stubEvolution } from "./drain-outbox.fixture.js";

describeWithDatabase("drain-outbox — a 404 marks the connection disconnected", () => {
  it("marks the connection DISCONNECTED, dated before the send, when Evolution answers 404", () =>
    withTestTransaction(db(), async (tx) => {
      // outbox-404-marks-disconnected (whatsapp-channel, "A 404 send marks the
      // connection disconnected"). Without this the stored column kept saying
      // CONNECTED and the due tick re-released the blocked copy forever.
      const { connection, conversationId, db: handle } = await setup(tx);
      await tx.whatsAppConnection.update({ where: { id: connection.id }, data: { connectionState: "CONNECTED" } });
      await enqueue(tx, conversationId, "body");
      const before = Date.now();
      let sendCalledAt = 0;

      await drainOnce({
        db: handle,
        evolution: stubEvolution({
          async sendText() {
            sendCalledAt = Date.now();
            return { ok: false, kind: "disconnected", error: "evolution 404" };
          },
        }),
      });

      const row = await tx.whatsAppConnection.findUniqueOrThrow({ where: { id: connection.id } });
      expect(row.connectionState).toBe("DISCONNECTED");
      expect(row.lastDisconnectedAt).toEqual(row.stateObservedAt);
      const observed = row.stateObservedAt?.getTime() ?? Number.NaN;
      expect(observed).toBeGreaterThanOrEqual(before);
      expect(observed).toBeLessThanOrEqual(sendCalledAt);
    }));

  it("leaves a state observed after the 404 send began", () =>
    withTestTransaction(db(), async (tx) => {
      // A connection.update received while the send was in flight is newer
      // than the 404 and wins, through updateConnectionState's guard.
      const { connection, conversationId, db: handle } = await setup(tx);
      await enqueue(tx, conversationId, "body");
      const reopened = new Date(Date.now() + 60_000);

      await drainOnce({
        db: handle,
        evolution: stubEvolution({
          async sendText() {
            await tx.whatsAppConnection.update({
              where: { id: connection.id },
              data: { connectionState: "CONNECTED", stateObservedAt: reopened, lastConnectedAt: reopened },
            });
            return { ok: false, kind: "disconnected", error: "evolution 404" };
          },
        }),
      });

      const row = await tx.whatsAppConnection.findUniqueOrThrow({ where: { id: connection.id } });
      expect(row.connectionState).toBe("CONNECTED");
      expect(row.stateObservedAt).toEqual(reopened);
      expect(row.lastDisconnectedAt).toBeNull();
    }));

  it("keeps draining when the 404's connection-state write fails", () =>
    withTestTransaction(db(), async (tx) => {
      // Review of #207: the row is already blocked, so a failed state write is
      // logged and the tick goes on to the message behind it.
      const { conversationId, db: handle } = await setup(tx);
      const first = await enqueue(tx, conversationId, "first");
      const second = await enqueue(tx, conversationId, "second");
      // created_at is NOW(), fixed inside the test transaction: order them.
      await tx.outboxMessage.update({ where: { id: second }, data: { createdAt: new Date(Date.now() + 1_000) } });
      await tx.outboxMessage.update({ where: { id: first }, data: { createdAt: new Date(Date.now() - 1_000) } });
      let calls = 0;
      // Fails only the third transaction: the claim, then markBlocked, then the
      // state write. Everything after it runs normally.
      const failing: Db = {
        ...handle,
        tx: ((module: ModuleName, fn: never, run?: RunInTransaction) =>
          ++calls === 3 ? Promise.reject(new Error("state write failed")) : handle.tx(module, fn, run)) as Db["tx"],
      };
      const logs: string[] = [];
      let sends = 0;

      await drainOutbox({
        db: failing,
        evolution: stubEvolution({
          async sendText() {
            sends += 1;
            return sends === 1
              ? { ok: false, kind: "disconnected", error: "evolution 404" }
              : { ok: true, externalMessageId: "after", providerTimestamp: null };
          },
        }),
        log: (message) => logs.push(message),
        cap: 2,
      });

      expect((await rowOf(tx, first)).status).toBe("blocked");
      expect((await rowOf(tx, second)).status).toBe("confirmed");
      expect(logs.some((line) => line.includes("disconnected failed: Error"))).toBe(true);
    }));

  it("does not touch the connection state on a refused send", () =>
    withTestTransaction(db(), async (tx) => {
      // Positive control for the 404 case: only `disconnected` writes the state.
      const { connection, conversationId, db: handle } = await setup(tx);
      await tx.whatsAppConnection.update({ where: { id: connection.id }, data: { connectionState: "CONNECTED" } });
      await enqueue(tx, conversationId, "body");

      await drainOnce({
        db: handle,
        evolution: mockEvolution({ ok: false, kind: "refused", error: "send_refused_unauthorized" }),
      });

      const row = await tx.whatsAppConnection.findUniqueOrThrow({ where: { id: connection.id } });
      expect(row.connectionState).toBe("CONNECTED");
      expect(row.lastDisconnectedAt).toBeNull();
    }));

});
