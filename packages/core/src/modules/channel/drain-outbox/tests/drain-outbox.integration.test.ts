/**
 * Test design (testing-strategy)
 *
 * SUT: `drainOnce` — one claimed row, sent through a stubbed `EvolutionSend`,
 *   outcome recorded — through the slice's entry point, on the real database in
 *   a rolling-back test transaction. No real Evolution HTTP.
 *
 * Ran under module role: `channel` — asserted, not assumed: the last case records
 *   the module every transaction asked for, and proves the role refuses a write
 *   to `message` inside one, which is why the insert became an event.
 *
 * Moved from apps/worker/src/outbox/drain.test.ts (adopt-modular-vertical-slices
 * 3A). That file had 30 tests; this one and its two siblings hold 28, and the
 * other 2 — a SEND_MESSAGE webhook arriving after the send — cross into ingest and
 * moved to the worker's composition test. The file's full header, its four
 * fake-only findings and its record of reversed behaviour are kept in
 * drain-outbox.loop.integration.test.ts; this header lists only what this file
 * covers.
 *
 * WHAT CHANGED IN THE ASSERTIONS, AND WHY IT IS THE SAME FACT. "Inserts one
 * canonical message" used to be read back from `message`. The drain no longer
 * writes that table (exception W3-C4): it publishes `channel/outbound-sent` and the
 * worker subscribes the unchanged ingest insert. So each such assertion now reads
 * the published event — its count, its provider timestamp, its message type —
 * and "no canonical message" is "no event". That the subscriber turns the event
 * into exactly one row is the worker composition test's to show.
 *
 * Oracle: main whatsapp-channel outbox requirement (drain paragraph, disconnect,
 *   no body in logs) + outbox-failure-pacing + outbox-send-provider-timestamp +
 *   scheduled-messages 3.4 (a cancelled row is never claimed or transitioned).
 *
 * Axes: 1 claimQueued empty vs queued; 2 send ok | disconnect | other reject;
 *   8 providerTimestamp Date (publish + confirm) vs null (confirm, log, no
 *   publish); 9 cancelled — claim skip / mark* no-op; text body present vs null
 *   vs whitespace.
 */
import { expect, it } from "vitest";
import type { Db, DbClient, ModuleName, RunInTransaction } from "../../../../kernel/db.js";
import { subscribe } from "../../../../kernel/events.js";
import { outboundSent } from "../../contracts/outbound-sent.js";
import { describeWithDatabase, withTestTransaction } from "../../../../testing/index.js";
import { drainOnce, markBlocked, markConfirmed, markFailedQueued } from "../index.js";
import {
  db,
  drainCapturing,
  enqueue,
  mockEvolution,
  rowOf,
  rowsOf,
  setup,
  stubEvolution,
} from "./drain-outbox.fixture.js";

describeWithDatabase("drain-outbox — one row", () => {
  it("sends connected text and publishes one outbound-sent for the canonical message", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, "resposta");
      const logs: string[] = [];

      const outbound = await drainCapturing(connection.id, () =>
        drainOnce({
          db: handle,
          evolution: mockEvolution({
            ok: true,
            externalMessageId: "out-1",
            providerTimestamp: new Date("2026-01-01T12:00:00.000Z"),
          }),
          log: (message) => logs.push(message),
        }),
      );

      expect((await rowOf(tx, id)).status).toBe("confirmed");
      expect(outbound).toHaveLength(1);
      expect(outbound[0]?.providerTimestamp).toEqual(new Date("2026-01-01T12:00:00.000Z"));
      expect(logs.some((line) => line.includes("without timestamp"))).toBe(false);
      // The body never reaches the log.
      expect(logs.some((line) => line.includes("resposta"))).toBe(false);
    }));

  it("confirms the row, and logs, when the outbound-sent subscriber throws", () =>
    withTestTransaction(db(), async (tx) => {
      // Confirm BEFORE publish (owner rulings, 2026-09-25). Evolution has accepted
      // the send, so a subscriber that fails must not leave the row `claimed`:
      // reclaim-stuck would requeue it and the customer would get it twice. The
      // bubble comes from the SEND_MESSAGE webhook instead, pinned in
      // apps/worker/test/channel-wiring.test.ts. Mutation-checked: main's
      // publish-then-confirm fails this case, and so does confirming first but
      // letting the publish error escape.
      const { conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, "resposta");
      const logs: string[] = [];
      const off = subscribe(outboundSent, () => {
        throw Object.assign(new Error("insert boom resposta"), { code: "P2002" });
      });

      let outcome: Awaited<ReturnType<typeof drainOnce>>;
      try {
        outcome = await drainOnce({
          db: handle,
          evolution: mockEvolution({
            ok: true,
            externalMessageId: "out-sub-fails",
            providerTimestamp: new Date("2026-01-01T12:00:00.000Z"),
          }),
          log: (message) => logs.push(message),
        });
      } finally {
        off();
      }

      expect(outcome).toBe("confirmed");
      const row = await rowOf(tx, id);
      expect(row.status).toBe("confirmed");
      expect(row.externalMessageId).toBe("out-sub-fails");
      expect(logs).toContain(`outbox publish failed ${id} provider out-sub-fails: Error P2002`);
      // Neither the body nor the error's message, which here quotes it.
      expect(logs.some((line) => line.includes("resposta"))).toBe(false);
    }));

  it("confirms without publishing a canonical message when the send has no usable timestamp", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, "resposta");
      const logs: string[] = [];

      const outbound = await drainCapturing(connection.id, () =>
        drainOnce({
          db: handle,
          evolution: mockEvolution({ ok: true, externalMessageId: "out-no-ts", providerTimestamp: null }),
          log: (message) => logs.push(message),
        }),
      );

      const row = await rowOf(tx, id);
      expect(row.status).toBe("confirmed");
      expect(row.externalMessageId).toBe("out-no-ts");
      expect(outbound).toHaveLength(0);
      expect(
        logs.some((line) => line.includes("out-no-ts") && line.toLowerCase().includes("timestamp")),
      ).toBe(true);
      expect(logs.some((line) => line.includes("resposta"))).toBe(false);
    }));

  it("does not confirm a send when Evolution is disconnected", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, "secret-body");

      const outbound = await drainCapturing(connection.id, () =>
        drainOnce({
          db: handle,
          evolution: mockEvolution({ ok: false, kind: "disconnected", error: "evolution 404" }),
        }),
      );

      const row = await rowOf(tx, id);
      expect(row.status).toBe("blocked");
      expect(row.status).not.toBe("confirmed");
      expect(outbound).toHaveLength(0);
    }));

  it("returns without sending when the outbox has nothing queued", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, db: handle } = await setup(tx);
      let sent = 0;

      const outcome = await drainOnce({
        db: handle,
        evolution: stubEvolution({
          async sendText() {
            sent += 1;
            return { ok: true, externalMessageId: "x", providerTimestamp: new Date("2026-01-01T12:00:00.000Z") };
          },
        }),
      });

      expect(outcome).toBe("empty");
      expect(sent).toBe(0);
      expect(await rowsOf(tx, conversationId)).toHaveLength(0);
    }));

  it("requeues a send that failed before reaching Evolution", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, "resposta");

      const outbound = await drainCapturing(connection.id, () =>
        drainOnce({
          db: handle,
          evolution: mockEvolution({ ok: false, kind: "retryable", error: "network ECONNREFUSED" }),
        }),
      );

      const row = await rowOf(tx, id);
      expect(row.status).toBe("queued");
      expect(row.attemptCount).toBe(1);
      expect(outbound).toHaveLength(0);
    }));

  it("refuses an outbound text with no body instead of sending an empty message", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, null);
      let sends = 0;
      const evolution = stubEvolution({
        async sendText() {
          sends += 1;
          return { ok: true, externalMessageId: "x", providerTimestamp: new Date() };
        },
      });

      await drainOnce({ db: handle, evolution });

      expect(sends).toBe(0);
      const row = await rowOf(tx, id);
      // A refusal fails at once (hold-unknown-outcome-sends): retrying cannot fill the body.
      expect(row.status).toBe("failed");
      expect(row.lastError).toBe("missing text body");
    }));

  it("treats a whitespace-only body as empty, as the media caption branch already does", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, "   \n  ");
      let sends = 0;
      const evolution = stubEvolution({
        async sendText() {
          sends += 1;
          return { ok: true, externalMessageId: "x", providerTimestamp: new Date() };
        },
      });

      await drainOnce({ db: handle, evolution });

      expect(sends).toBe(0);
      expect((await rowOf(tx, id)).lastError).toBe("missing text body");
    }));

  it("does not claim a cancelled outbox row", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, "depois");
      await tx.outboxMessage.update({ where: { id }, data: { status: "cancelled" } });
      let sent = 0;

      const outcome = await drainOnce({
        db: handle,
        evolution: stubEvolution({
          async sendText() {
            sent += 1;
            return { ok: true, externalMessageId: "p", providerTimestamp: null };
          },
        }),
      });

      expect(outcome).toBe("empty");
      expect(sent).toBe(0);
      expect((await rowOf(tx, id)).status).toBe("cancelled");
    }));

  it("does not transition a cancelled row from markConfirmed or markBlocked", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, db: handle } = await setup(tx);
      const id = await enqueue(tx, conversationId, "depois");
      await tx.outboxMessage.update({ where: { id }, data: { status: "cancelled" } });

      await markConfirmed(handle, id, "prov-x");
      expect((await rowOf(tx, id)).status).toBe("cancelled");
      await markBlocked(handle, id, "nope");
      expect((await rowOf(tx, id)).status).toBe("cancelled");
      // The RETURNING clause yields no row, so the caller sees null.
      expect(await markFailedQueued(handle, id, "nope")).toBeNull();
      expect((await rowOf(tx, id)).status).toBe("cancelled");
    }));

  it("claims and confirms under the channel role, sends outside any transaction, and cannot write message", () =>
    withTestTransaction(db(), async (tx) => {
      const { conversationId, db: real } = await setup(tx);
      await enqueue(tx, conversationId, "resposta");
      const modules: ModuleName[] = [];
      let open = 0;
      let openDuringSend = -1;
      let intrude = false;
      const spy: Db = {
        client: real.client,
        tx<T>(module: ModuleName, fn: (inner: DbClient) => Promise<T>, run?: RunInTransaction) {
          modules.push(module);
          return real.tx(
            module,
            async (inner) => {
              open += 1;
              try {
                if (intrude) {
                  // Permission is checked before any constraint, so the empty
                  // row is refused for the role, not for its missing columns.
                  await inner.$executeRaw`INSERT INTO message (id) VALUES ('intruder')`;
                }
                return await fn(inner);
              } finally {
                open -= 1;
              }
            },
            run,
          );
        },
      };
      const evolution = stubEvolution({
        async sendText() {
          openDuringSend = open;
          return { ok: true, externalMessageId: "role-1", providerTimestamp: null };
        },
      });

      await expect(drainOnce({ db: spy, evolution })).resolves.toBe("confirmed");
      // Claim, then confirm: two transactions, both channel's (W2-C12).
      expect(modules).toEqual(["channel", "channel"]);
      expect(openDuringSend).toBe(0);

      // Last, because a refused write aborts the test transaction.
      await enqueue(tx, conversationId, "outra");
      intrude = true;
      await expect(drainOnce({ db: spy, evolution })).rejects.toThrow(/permission denied for table message/);
    }));
});
