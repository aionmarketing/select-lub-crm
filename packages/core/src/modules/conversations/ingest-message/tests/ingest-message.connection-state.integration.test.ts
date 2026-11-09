/**
 * Test design (testing-strategy)
 *
 * Moved from apps/worker/src/ingest/connection-state.test.ts (adopt-modular-vertical-slices 4A),
 * all cases, assertions unchanged. Ran under module roles: `conversations` for
 * conversation/message, `channel` (through its contracts) for webhook_event and
 * whatsapp_connection. Two mechanical changes: the store is `createIngestStore`
 * over the test transaction, and the insert hook the old cases counted is the
 * `conversations/message-received` event, counted at the same point.
 *
 * Setup: the real Prisma ingest store on the worktree database inside a
 * rolling-back test transaction (`withTestTransaction`), driven through
 * `persistRawEvent` / `canonicalizeEvent` with the `connectionUpdatePayload`,
 * `qrUpdatedPayload` and `upsertPayload` fixtures. No HTTP.
 *
 * Spec (openspec/changes/conversas-inbox-completeness/specs/whatsapp-channel/spec.md
 *   — "Connection events update canonical session state"):
 *   CONNECTION_UPDATE `open`/`connecting`/`close` map to
 *   CONNECTED/CONNECTING/DISCONNECTED. QRCODE_UPDATED while not `open` sets
 *   CONNECTING and never persists QR bytes. Unknown instance names stay
 *   webhook-only. Neither event creates a conversation or message row.
 *
 * RESOLUTION IS BY INSTANCE NAME, WITH NO DEFAULT (tasks 6.1; #89, #91).
 * `persistRawEvent` resolves the connection solely through
 * `findConnectionByInstanceName(envelopeInstance(payload))`, which on the Prisma
 * adapter is a `findUnique` on the `instanceName` unique key — the same key the
 * API resolves channel identity by after #89. #91 then made an unset
 * `EVOLUTION_INSTANCE_NAME` a loud refusal in the API precisely because a name
 * that matches nothing returns null rather than raising, and null presents as an
 * empty inbox rather than an error.
 *
 * So every payload here is built with an EXPLICIT `instance` equal to the
 * instance name of the connection this test seeded. Nothing is left to the
 * fixture's `"select-lub-test"` default, and no fallback name is introduced
 * anywhere in this file: a test that relied on a default would be asserting the
 * fixture agrees with itself, which is exactly the shape #91 removed from the API.
 * The generated name also means the test never writes to a connection the base or
 * demo seed owns, so it holds no locks another parallel file waits on.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (route-tests-on-real-database, D10). Two.
 *
 *   1. `expect(store.conversations()).toHaveLength(0)` and the matching
 *      `messages()` assertion were absolute counts over the fake's whole map.
 *      Against the real database those are counts over the pristine base and the
 *      demo seed as well, so they are rewritten as deltas scoped to this test's
 *      own connection (design.md D9).
 *
 *   2. `expect(store.messages()).toHaveLength(1)` in the message-path case was
 *      likewise absolute. More than a count changed: the fake keyed messages on
 *      `conversationId + externalMessageId` held in a flat map, while the adapter
 *      reaches a message only through `conversation.whatsapp_connection_id`. The
 *      corrected assertion walks that join, which is the relationship PR #89's
 *      bug lived in and which the fake could not represent at all.
 *
 * The QR-bytes assertion changed shape for a related reason: the old file
 * stringified the fake's in-memory connection row. The real check is that no
 * column of the persisted row carries the QR payload, so it reads the row back
 * from the transaction and stringifies that.
 *
 * Axes
 *   1. event kind — CONNECTION_UPDATE (open/connecting/close/unrecognized
 *      state) vs QRCODE_UPDATED vs an unrelated canonical-message event
 *   2. instance on persist — known connection vs unknown instance
 *
 * Decisions (canonicalize.ts connection branch; parse.ts parseConnectionEvent)
 *   D1 parseConnectionEvent status === "update" — connection/QR event vs
 *      message event (message path untouched, proven by one `it` here and
 *      by canonicalize.test.ts's existing message suite)
 *   D2 event.whatsappConnectionId present — known vs unknown instance
 *   D3 QRCODE_UPDATED vs CONNECTION_UPDATE — QR always CONNECTING; the
 *      other event reads `data.state`
 *   D4 CONNECTION_UPDATE `data.state` — open / connecting / close /
 *      missing-or-unrecognized (skip)
 *
 *   it                                                    | D1 | D2 | D3  | D4
 *   open maps to CONNECTED                                | T  | T  | F   | open
 *   connecting maps to CONNECTING                         | T  | T  | F   | connecting
 *   close maps to DISCONNECTED                            | T  | T  | F   | close
 *   unrecognized state is skipped, no state written       | T  | T  | F   | other
 *   QR without open sets CONNECTING and stores no QR bytes| T  | T  | T   | -
 *   unknown instance leaves the row untouched             | T  | F  | F   | open
 *   connection/QR events create no conversation or message| T  | T  | T/F | -
 *   a 1:1 message event still canonicalizes               | F  | T  | F   | -
 *
 * Observation time (owner rulings, 2026-09-25): the state is written as observed
 * at the event's RECEIPT (`webhook_event.created_at`), not when it is processed,
 * and only when that is not older than the stored observation.
 *   D5 stored state_observed_at vs the event's created_at — older / later / equal
 *
 *   it                                                         | D5
 *   stamps the receipt time, not the processing time          | none stored
 *   a retried event older than the stored state is dropped    | later stored
 *   a same-millisecond event still lands                      | equal
 *
 * Inside one test transaction every event's created_at is the transaction's
 * start, so these cases set it explicitly.
 *
 * Fails if: a CONNECTION_UPDATE `close` after an earlier `open` still reads
 * CONNECTED; QRCODE_UPDATED payload fields (qrcode.base64 / qrcode.code) end up
 * anywhere on the stored connection row; an unknown instance's event still
 * finds/updates a connection; the message path stops reaching its message
 * through the connection join.
 *
 * Not in this file: DEGRADED (no confirmed trigger payload — see design.md; the
 * shared-types and web suites cover the UI accepting and rendering that value);
 * retry/terminal-status plumbing (canonicalize.test.ts); live Evolution payloads
 * (PEND-CH-01).
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  seedConnection,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import type { DbClient } from "@select-lub/core/db";
import { expect, it } from "vitest";
import { canonicalizeEvent, persistRawEvent } from "../index.js";
import { connectionUpdatePayload, qrUpdatedPayload, upsertPayload } from "../../../../testing/index.js";
import { countMessagesReceived, ingestStoreOn } from "./ingest.fixture.js";

const db = () => prisma as PrismaClient;

/**
 * Seeds a unit and a connection and builds the real ingest store on the same
 * transaction.
 *
 * The connection's instance name is generated per test, and every payload below
 * passes it explicitly, so resolution is by that name alone.
 *
 * @param tx - The test transaction.
 * @param connectionState - Starting state for the connection row.
 * @returns The connection row and the store built on `tx`.
 */
async function setup(tx: DbClient, connectionState = "DISCONNECTED") {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id, connectionState });
  const store = ingestStoreOn(tx);
  return { connection, store };
}

describeWithDatabase("connection state canonicalization", () => {
  it("maps CONNECTION_UPDATE open to CONNECTED", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const { id } = await persistRawEvent(
        store,
        connectionUpdatePayload({ instance: connection.instanceName, state: "open" }),
      );

      await canonicalizeEvent(store, id);

      const row = await tx.whatsAppConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });
      expect(row.connectionState).toBe("CONNECTED");
      expect(row.lastConnectedAt).not.toBeNull();
      expect((await store.getEvent(id))?.status).toBe("processed");
    }));

  it("maps CONNECTION_UPDATE connecting to CONNECTING", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const { id } = await persistRawEvent(
        store,
        connectionUpdatePayload({ instance: connection.instanceName, state: "connecting" }),
      );

      await canonicalizeEvent(store, id);

      const row = await tx.whatsAppConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });
      expect(row.connectionState).toBe("CONNECTING");
    }));

  it("maps CONNECTION_UPDATE close to DISCONNECTED", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx, "CONNECTED");
      const { id } = await persistRawEvent(
        store,
        connectionUpdatePayload({ instance: connection.instanceName, state: "close" }),
      );

      await canonicalizeEvent(store, id);

      const row = await tx.whatsAppConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });
      expect(row.connectionState).toBe("DISCONNECTED");
      expect(row.lastDisconnectedAt).not.toBeNull();
    }));

  it("skips an unrecognized or missing state without writing the row", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const unrecognized = await persistRawEvent(
        store,
        connectionUpdatePayload({
          instance: connection.instanceName,
          state: "unknown-state",
        }),
      );
      await canonicalizeEvent(store, unrecognized.id);
      const missing = await persistRawEvent(
        store,
        connectionUpdatePayload({ instance: connection.instanceName, state: null }),
      );
      await canonicalizeEvent(store, missing.id);

      const row = await tx.whatsAppConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });
      expect(row.connectionState).toBe("DISCONNECTED");
      expect((await store.getEvent(unrecognized.id))?.status).toBe("skipped");
      expect((await store.getEvent(missing.id))?.status).toBe("skipped");
    }));

  it("sets CONNECTING on QRCODE_UPDATED and stores no QR bytes", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const { id } = await persistRawEvent(
        store,
        qrUpdatedPayload({ instance: connection.instanceName }),
      );

      await canonicalizeEvent(store, id);

      const row = await tx.whatsAppConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });
      expect(row.connectionState).toBe("CONNECTING");
      // No column of the persisted row may carry the pairing payload.
      expect(JSON.stringify(row)).not.toContain("not-real-qr-data");
      expect(JSON.stringify(row)).not.toContain("not-real-pairing-code");
    }));

  it("leaves no connection updated for an unknown instance", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const unknownInstance = `${connection.instanceName}-absent`;
      expect(
        await tx.whatsAppConnection.findUnique({ where: { instanceName: unknownInstance } }),
      ).toBeNull(); // precondition: the name really resolves to nothing

      const { id } = await persistRawEvent(
        store,
        connectionUpdatePayload({ instance: unknownInstance, state: "open" }),
      );
      await canonicalizeEvent(store, id);

      expect((await store.getEvent(id))?.whatsappConnectionId).toBeNull();
      expect((await store.getEvent(id))?.status).toBe("skipped");
      const row = await tx.whatsAppConnection.findUniqueOrThrow({
        where: { id: connection.id },
      });
      expect(row.connectionState).toBe("DISCONNECTED");
    }));

  it("does not create a conversation or message row for connection/QR events", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const hooks = countMessagesReceived();
      const open = await persistRawEvent(
        store,
        connectionUpdatePayload({ instance: connection.instanceName, state: "open" }),
      );
      await canonicalizeEvent(store, open.id);
      const qr = await persistRawEvent(
        store,
        qrUpdatedPayload({ instance: connection.instanceName }),
      );
      await canonicalizeEvent(store, qr.id);

      // Deltas scoped to this test's connection, not counts of the whole table.
      expect(
        await tx.conversation.count({ where: { whatsappConnectionId: connection.id } }),
      ).toBe(0);
      expect(
        await tx.message.count({
          where: { conversation: { whatsappConnectionId: connection.id } },
        }),
      ).toBe(0);
      expect(hooks.count).toBe(0);
    }));

  it("still canonicalizes a 1:1 message event through the untouched message path", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const { id } = await persistRawEvent(
        store,
        upsertPayload({ instance: connection.instanceName }),
      );

      await canonicalizeEvent(store, id);

      // Reached through the connection join the fake had no concept of.
      const messages = await tx.message.findMany({
        where: { conversation: { whatsappConnectionId: connection.id } },
      });
      expect(messages).toHaveLength(1);
    }));

  /** Persists a CONNECTION_UPDATE and dates its receipt at `receivedAt`. */
  async function received(
    tx: DbClient,
    store: Awaited<ReturnType<typeof setup>>["store"],
    instanceName: string,
    state: string,
    receivedAt: Date,
  ) {
    const { id } = await persistRawEvent(store, connectionUpdatePayload({ instance: instanceName, state }));
    await tx.webhookEvent.update({ where: { id }, data: { createdAt: receivedAt } });
    return id;
  }

  it("stamps the state with the event's receipt time, not the time it is processed", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, store } = await setup(tx);
      const receivedAt = new Date("2026-09-20T10:00:00.000Z");
      const id = await received(tx, store, connection.instanceName, "open", receivedAt);

      await canonicalizeEvent(store, id);

      const row = await tx.whatsAppConnection.findUniqueOrThrow({ where: { id: connection.id } });
      expect(row.connectionState).toBe("CONNECTED");
      expect(row.stateObservedAt).toEqual(receivedAt);
      expect(row.lastConnectedAt).toEqual(receivedAt);
    }));

  it("drops a retried event received before the stored state was observed", () =>
    withTestTransaction(db(), async (tx) => {
      // A `close` that failed on arrival and is retried on a later heartbeat,
      // after the reconcile has observed the session open again.
      const { connection, store } = await setup(tx, "CONNECTED");
      const reconciledAt = new Date("2026-09-20T10:05:00.000Z");
      await tx.whatsAppConnection.update({
        where: { id: connection.id },
        data: { stateObservedAt: reconciledAt, lastConnectedAt: reconciledAt },
      });
      const id = await received(tx, store, connection.instanceName, "close", new Date("2026-09-20T10:00:00.000Z"));

      await canonicalizeEvent(store, id);

      const row = await tx.whatsAppConnection.findUniqueOrThrow({ where: { id: connection.id } });
      expect(row.connectionState).toBe("CONNECTED");
      expect(row.stateObservedAt).toEqual(reconciledAt);
      expect(row.lastDisconnectedAt).toBeNull();
      // Handled, not failed: an older fact is not an error to retry.
      expect((await store.getEvent(id))?.status).toBe("processed");
    }));

  it("lets an event received in the same millisecond as the stored state land", () =>
    withTestTransaction(db(), async (tx) => {
      // `connecting` then `open` inside one millisecond: the second must not be
      // dropped as "not newer", or the session reads CONNECTING for ever.
      const { connection, store } = await setup(tx);
      const sameMs = new Date("2026-09-20T10:00:00.000Z");
      const first = await received(tx, store, connection.instanceName, "connecting", sameMs);
      const second = await received(tx, store, connection.instanceName, "open", sameMs);

      await canonicalizeEvent(store, first);
      await canonicalizeEvent(store, second);

      const row = await tx.whatsAppConnection.findUniqueOrThrow({ where: { id: connection.id } });
      expect(row.connectionState).toBe("CONNECTED");
    }));
});
