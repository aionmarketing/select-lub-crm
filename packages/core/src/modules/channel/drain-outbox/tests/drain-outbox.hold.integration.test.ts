/**
 * Test design (testing-strategy)
 *
 * SUT: `drainOnce` recording each class of failed send, on the real database
 *   inside a rolling-back transaction, with Evolution a stub port. The hung send
 *   through the real client is in `packages/core/test/hold-unknown-outcome.test.ts`:
 *   a slice test may not import `internal/`.
 *
 * Oracle: `hold-unknown-outcome-sends`, whatsapp-channel "A send whose outcome is
 *   unknown is held for a person" and the modified "Simple single-worker outbox
 *   sends attendant text" / media requirements: a refused or unknown send is
 *   `failed` at once and never claimed again; a retryable one returns to
 *   `queued`; a hung send is abandoned at its limit and does not hold the queue;
 *   a failed media row keeps no bytes; no throw leaves a row `claimed`.
 *
 * Cases
 *   1. unknown → failed / send_outcome_unknown, one send, never claimed again
 *   2. refused (not on WhatsApp) → failed with the refusal, not blocked
 *   3. retryable → queued, attempt 1 (the control for 1 and 2)
 *   4. a port that throws → failed / send_outcome_unknown, not left claimed
 *   5. an unknown media send discards the bytes
 */
import { expect, it, vi } from "vitest";
import { drainOnce } from "../index.js";
import { db, enqueue, mockEvolution, setup, stubEvolution } from "./drain-outbox.fixture.js";
import { describeWithDatabase, withTestTransaction } from "../../../../testing/index.js";
import type { DbClient } from "../../../../kernel/db.js";

function rowOf(tx: DbClient, id: string) {
  return tx.outboxMessage.findUniqueOrThrow({
    where: { id },
    select: { status: true, lastError: true, attemptCount: true, claimedAt: true, mediaBytes: true },
  });
}

describeWithDatabase("drain-outbox holds a send that might have arrived", () => {
  it("fails an unknown outcome at once and never claims it again", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, "resposta");
      const sendText = vi.fn(async () => ({ ok: false as const, kind: "unknown" as const, error: "evolution 504" }));
      const evolution = stubEvolution({ sendText });

      expect(await drainOnce({ db: handle, evolution })).toBe("failed");
      expect(await rowOf(tx, id)).toMatchObject({
        status: "failed",
        lastError: "send_outcome_unknown",
        attemptCount: 1,
        claimedAt: null,
      });
      // Past any backoff: a failed row is not claimable at all.
      await tx.$executeRaw`UPDATE outbox_message SET updated_at = NOW() - INTERVAL '1 hour' WHERE id = ${id}`;
      expect(await drainOnce({ db: handle, evolution })).toBe("empty");
      expect(sendText).toHaveBeenCalledTimes(1);
    }));

  it("fails a refused send at once with the refusal, not blocked", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, "resposta");

      const outcome = await drainOnce({
        db: handle,
        evolution: mockEvolution({ ok: false, kind: "refused", error: "send_refused_not_on_whatsapp" }),
      });

      expect(outcome).toBe("failed");
      expect(await rowOf(tx, id)).toMatchObject({ status: "failed", lastError: "send_refused_not_on_whatsapp" });
    }));

  it("requeues a send that never reached Evolution", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, "resposta");

      const outcome = await drainOnce({
        db: handle,
        evolution: mockEvolution({ ok: false, kind: "retryable", error: "network ECONNREFUSED" }),
      });

      expect(outcome).toBe("requeued");
      expect(await rowOf(tx, id)).toMatchObject({ status: "queued", attemptCount: 1, lastError: "network ECONNREFUSED" });
    }));

  it("records a port that throws as an unknown outcome instead of leaving the row claimed", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, "resposta");
      const evolution = stubEvolution({
        async sendText() {
          throw new Error("socket hang up");
        },
      });

      expect(await drainOnce({ db: handle, evolution })).toBe("failed");
      expect(await rowOf(tx, id)).toMatchObject({ status: "failed", lastError: "send_outcome_unknown" });
    }));

  it("discards a media row's bytes when its outcome is unknown", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, null, {
        messageType: "image",
        mediaBytes: new Uint8Array([0xff, 0xd8, 0xff]),
        mediaMimeType: "image/jpeg",
        mediaFileName: "foto.jpg",
      });

      await drainOnce({
        db: handle,
        evolution: stubEvolution({
          async sendText() {
            throw new Error("not a text row");
          },
          async sendMedia() {
            return { ok: false, kind: "unknown", error: "network TimeoutError" };
          },
        }),
      });

      expect(await rowOf(tx, id)).toMatchObject({ status: "failed", lastError: "send_outcome_unknown", mediaBytes: null });
    }));
});
