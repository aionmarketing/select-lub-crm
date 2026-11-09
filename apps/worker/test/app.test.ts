/**
 * Test design (testing-strategy)
 *
 * Setup: Fastify inject on `buildWorkerApp` — the worker's app, carrying
 * channel's `receive-webhook` route and the `canonicalizeEvent` subscriber —
 * with channel's database handle and the real Prisma ingest store, both built on
 * the worktree database inside a rolling-back test transaction
 * (`withTestTransaction`). Bearer secret "test-webhook-secret".
 *
 * MOVED WITH THE ROUTE (adopt-modular-vertical-slices 3A, ruling Q6). This was
 * webhook.test.ts, 18 cases. The route's receipt — auth, the 503 arms, the stored
 * row, the log line — is channel's `receive-webhook` slice now, and its 5 cases
 * plus the 4 `summarizeWebhook` cases moved to
 * packages/core/src/modules/channel/receive-webhook/tests/. The 9 here pin what
 * only the whole worker app shows: `/health`, the 50 MiB body limit, and what
 * canonicalization makes of the stored rows. The partition and map lists below
 * are the original file's; P1–P3, P5 and P6 now live in core.
 *
 * ONE POST AT A TIME WHEN CANONICALIZATION WRITES. Every call here shares ONE
 * test transaction, so one connection. Channel's receipt runs in
 * `db.tx("channel")`, which sets `SET LOCAL ROLE module_channel` on that
 * connection for the length of its insert; the previous post's canonicalization,
 * still running after its 200, runs its own statements on the same connection
 * with no role of its own, so a message insert landing inside that window is
 * refused for the `channel` role — and a refused statement aborts the whole test
 * transaction, which then hangs every completion wait. The cases that
 * canonicalize into `message` therefore wait for each post before the next. In
 * production the two run on separate connections and cannot interleave like
 * this. The non-canonical case posts back to back: its canonicalizations write
 * only `webhook_event`, which is channel's own table.
 *
 * Spec rule (conversation-phone-unique delta whatsapp-channel; main
 *   openspec/specs/channel/whatsapp-channel/spec.md still names uniqueness as
 *   (whatsapp_connection_id, external_message_id) until archive):
 *   Authenticated webhook. Idempotent insert on
 *   (conversation_id, external_message_id). Overlapping ingest.
 *   Non-canonical events (including @lid without a phone) stored without
 *   inbox rows. Hook after commit.
 *
 * FAKE-ONLY ASSERTIONS SURFACED (route-tests-on-real-database, D10). Four, and
 * the first is the one that matters: it was not a wrong assertion but a wrong
 * assumption about WHEN the route finishes.
 *
 *   1. Nine of these cases asserted on state that canonicalization had not
 *      written yet. The route sends its 200 before awaiting `canonicalizeEvent`,
 *      so `app.inject()` resolves with the work still in flight. The fake hid it
 *      completely — its whole chain was already-resolved promises that drained in
 *      the same microtask turn — and four cases failed on the real adapter the
 *      moment the awaits became real round trips. Four more had been passing
 *      VACUOUSLY: the ones asserting that no conversation or message exists were
 *      true simply because nothing had run yet, so they would have passed against
 *      a route that never canonicalized at all. Both groups now await a
 *      completion signal, never a sleep or a retry loop; `withCompletion` below
 *      documents the signal and why `markEvent` is the right one.
 *
 *   2. Every read was `store.events()`, `store.conversations()`,
 *      `store.messages()` or an index into one — absolute counts over the
 *      fake's whole maps, guarded by the `"events" in store` type narrowing the
 *      fake's extra helpers forced. On the real database those range over the
 *      pristine base and the demo seed as well, so each is now a count or a
 *      lookup scoped to the connection this test created, and the narrowing
 *      disappears because the Prisma store is exactly a `Persistence` with no
 *      test-only surface (design.md D9).
 *
 *   3. The chat-key cases — "@c.us for the same phone" and "device suffix" —
 *      were the ones worth migrating. They assert that two differently-spelled
 *      JIDs land on ONE conversation, which on the adapter is the
 *      `(whatsapp_connection_id, chat_key)` unique index doing the work through
 *      `ON CONFLICT ... DO UPDATE`. The fake deduped on a flat unit + phone pair
 *      it maintained itself, so it could have agreed with the test while
 *      disagreeing with the schema — which is exactly the divergence PR #89 shipped
 *      through. They now exercise the real index, and the `remoteJid` assertion
 *      additionally pins that the conflict path UPDATES the stored JID to the
 *      latest spelling rather than leaving the first.
 *
 *   4. `expect(store.conversations()[0]?.whatsappConnectionId).toBe(connection.id)`
 *      in the concurrency case read a flat column the fake invented. The real
 *      conversation carries that column too, but the fact under test — the
 *      message belongs to this connection's thread — is now asserted through the
 *      join the adapter actually uses, `message -> conversation ->
 *      whatsapp_connection_id`.
 *
 * Partitions (one numbered group = auth/payload outcomes the spec treats
 * the same. Each INVALID group has its own `it`.):
 *
 *   P1 VALID   — Bearer + store + MESSAGES_UPSERT → 200, 1 event, no file
 *                named with ABC123, logs omit body text and the secret
 *   P2 INVALID — missing Authorization → 401, 0 events
 *   P3 INVALID — Bearer wrong → 401, 0 events
 *   P4 VALID   — body 1.5 MiB MESSAGES_SET (above Fastify's 1 MiB default)
 *                → 200, event stored, inbox empty
 *   P5 INVALID — secret unset → 503, 0 events
 *   P6 INVALID — store unset → 503
 *   P7 VALID   — same upsert × 3 → 1 conversation, 1 message, 3 events, 1 hook
 *   P8 VALID   — SEND_MESSAGE sharing an external id with fromMe upsert
 *                → still 1 message; SEND_MESSAGE alone still inserts
 *   P9 VALID   — two concurrent canonicalizes of the same id → 1 message,
 *                hook ≤ 1
 *   P10 INVALID — non-canonical (group jid, @lid without a phone, unknown
 *                instance, MESSAGES_SET, missing timestamp) → 200, events
 *                stored, no inbox
 *   P11 VALID   — GET /health without Bearer → 200 `{ status: "ok", commit }`,
 *                where commit is the build's SHA or `unknown` when the image
 *                was built without it (deploy — "Published images report
 *                their build identity"; the worker serves no SPA, so this
 *                field is the only way to tell which image is running)
 *
 * Output partitions:
 *   O1 — 200 + stored event (P1/P4/P7/P8/P9)
 *   O2 — 401 + no writes (P2/P3)
 *   O3 — 503 (P5/P6)
 *   O4 — 200 + events without inbox rows (P10)
 *
 * Limits (boundary value analysis):
 *   Fastify default body cap is 1 MiB. Example is 1.5 MiB (above).
 *   1 MiB − 1 is not asserted. Replay count 3 means "more than once";
 *   2 replays would be the same duplicate-delivery group.
 *
 * Map from each `it` to a partition:
 *
 *   accepts a valid Bearer secret and persists a webhook event without a file sink
 *     — P1
 *   rejects a missing Authorization header — P2
 *   rejects a wrong Bearer token — P3
 *   accepts a payload larger than Fastify's 1 MiB default — P4
 *   returns 503 when the webhook secret is unset — P5
 *   returns 503 when the ingest store is unset — P6
 *   replays the same upsert three times as one conversation and one message — P7
 *   dedupes SEND_MESSAGE with the same external id and can ingest send.message alone
 *     — P8
 *   keeps a single message when two ingests of the same id run concurrently — P9
 *   stores non-canonical events without inbox rows and rejects 401 with no writes
 *     — P10 + P2 again (no Authorization on the last POST)
 *
 * What would make a test fail:
 *   200 with no Bearer
 *   3 inbox messages after 3 replays of the same upsert
 *
 * summarizeWebhook moved to core with the route (see above).
 *
 * Not in this file: live media bytes; pairing QR; inner-transaction rollback
 * (canonicalize.test.ts, outside the harness per design D2).
 */
import { prisma, type PrismaClient } from "@select-lub/core/db";
import type { DbClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedUnit,
  withTestTransaction,
} from "@select-lub/core/testing";
import { afterEach, expect, it, vi } from "vitest";
import { kernel } from "@select-lub/core";
import { buildWorkerApp } from "../src/worker.js";
import { expectedTimestamp, upsertPayload } from "@select-lub/core/testing";
import {
  canonicalizeEvent,
  createIngestStore,
  persistRawEvent,
} from "@select-lub/core/modules/conversations";
import { messageReceived } from "@select-lub/core/modules/conversations/contracts";

const secret = "test-webhook-secret";

/** Build SHA stubbed into the health cases; any full lowercase git object name. */
const HEALTH_SHA = "a7cdf67b1e4d2c9f08b3a561d7e4c2098fb31d45";

const db = () => prisma as PrismaClient;

/** The minimum of Fastify's app surface these tests drive. */
type InjectableApp = {
  inject: (opts: object) => Promise<{ statusCode: number; body: string }>;
  close: () => Promise<void>;
};

/**
 * Wraps a store so a test can await the END of canonicalization.
 *
 * WHY THIS IS NEEDED, and it is the headline finding of this file. The route
 * answers BEFORE it finishes:
 *
 *   const event = await persistRawEvent(store, request.body);
 *   await reply.code(200).send({ ok: true });
 *   await canonicalizeEvent(store, event.id, onMessageInserted, log);
 *
 * `app.inject()` resolves when the reply is sent, so canonicalization is still
 * in flight when the test's next line runs. Against the in-memory fake that was
 * invisible: every step was an already-resolved promise, so the whole chain
 * drained in the same microtask turn the `await inject(...)` yielded on, and the
 * conversation happened to be there by the time the assertion looked. Against
 * Postgres each step is a real round trip, and it is not.
 *
 * The fix is a completion SIGNAL, never a sleep or a retry loop
 * (memory: asserting-the-in-flight-state-hides-the-race). `markEvent` is that
 * signal: `canonicalizeEvent` calls it exactly once on every terminal path it
 * has — processed, skipped, failed and failed_permanent — and a freshly
 * persisted event is always `received`, so the early return for a terminal
 * status cannot skip it. Counting `markEvent` calls therefore counts finished
 * canonicalizations exactly.
 *
 * Deferring the work is deliberate, not a defect: the webhook acknowledges
 * quickly because Evolution retries anything that is not a 200. Nothing here
 * asks for that to change.
 *
 * @param store - The real ingest store.
 * @returns The store to hand the app, and a waiter for N finished events.
 */
function withCompletion(store: ReturnType<typeof createIngestStore>) {
  let settled = 0;
  let notify: (() => void) | undefined;
  const wrapped = {
    ...store,
    async markEvent(id: string, status: Parameters<typeof store.markEvent>[1]) {
      await store.markEvent(id, status);
      settled += 1;
      notify?.();
    },
  };

  /**
   * Resolves once at least `n` canonicalizations have reached a terminal status.
   *
   * Bounded by `withTestTransaction`'s own timeout, so a canonicalization that
   * never finishes fails the test rather than hanging it.
   *
   * @param n - How many finished events to wait for.
   */
  async function settledAtLeast(n: number): Promise<void> {
    while (settled < n) {
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
    notify = undefined;
  }

  return { store: wrapped, settledAtLeast };
}

describeWithDatabase("worker app: /health and POST /webhooks/evolution", () => {
  const apps: { close: () => Promise<void> }[] = [];
  // The insert hook these cases counted is the message-received event now.
  const offs: (() => void)[] = [];

  afterEach(async () => {
    for (const off of offs.splice(0)) off();
    // Closing twice is safe; the SEND_MESSAGE case closes its first app early.
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.unstubAllEnvs();
  });

  /**
   * Seeds a unit and a connection on `tx` and builds the webhook app over the
   * real ingest store.
   *
   * The connection's instance name is generated per test and every payload
   * passes it explicitly, so the webhook resolves it through
   * `findConnectionByInstanceName` with no default anywhere (#89, #91).
   *
   * @param tx - The test transaction.
   * @returns The app, the collected logs and hook calls, and the connection.
   */
  async function setup(tx: DbClient) {
    const logs: string[] = [];
    const hooks: number[] = [];
    offs.push(
      kernel.subscribe(messageReceived, () => {
        hooks.push(Date.now());
      }),
    );
    const unit = await seedUnit(tx);
    const connection = await seedConnection(tx, { unitId: unit.id });
    const real = createIngestStore(kernel.createDb(tx, runInTransactionOnTx(tx)));
    const { store, settledAtLeast } = withCompletion(real);
    const app = (await buildWorkerApp({
      secret,
      db: kernel.createDb(tx, runInTransactionOnTx(tx)),
      store,
      log: (message) => logs.push(message),
    })) as unknown as InjectableApp;
    apps.push(app);
    return { app, logs, hooks, connection, settledAtLeast };
  }

  /**
   * POSTs a payload to the webhook with a Bearer header by default.
   *
   * @param app - The built app.
   * @param payload - Request body.
   * @param headers - Header overrides.
   * @returns The injected response.
   */
  async function post(app: InjectableApp, payload: unknown, headers?: Record<string, string>) {
    return app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      headers: { authorization: `Bearer ${secret}`, ...headers },
      payload,
    });
  }

  /**
   * Counts this connection's webhook events. A delta, never the whole table.
   *
   * @param tx - The test transaction.
   * @param connectionId - The connection to scope to.
   * @returns The event count.
   */
  function eventCount(tx: DbClient, connectionId: string) {
    return tx.webhookEvent.count({ where: { whatsappConnectionId: connectionId } });
  }

  /**
   * This connection's conversations.
   *
   * @param tx - The test transaction.
   * @param connectionId - The connection to scope to.
   * @returns The conversation rows.
   */
  function conversationsOf(tx: DbClient, connectionId: string) {
    return tx.conversation.findMany({ where: { whatsappConnectionId: connectionId } });
  }

  /**
   * This connection's messages.
   *
   * @param tx - The test transaction.
   * @param connectionId - The connection to scope to.
   * @returns The message rows.
   */
  function messagesOf(tx: DbClient, connectionId: string) {
    return tx.message.findMany({
      where: { conversation: { whatsappConnectionId: connectionId } },
    });
  }

  it("answers GET /health without a Bearer token, reporting the built commit", () =>
    withTestTransaction(db(), async (tx) => {
      vi.stubEnv("GIT_COMMIT", HEALTH_SHA);
      const { app } = await setup(tx);

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ status: "ok", commit: HEALTH_SHA });
    }));

  it("reports commit unknown when the image was built without it", () =>
    withTestTransaction(db(), async (tx) => {
      vi.stubEnv("GIT_COMMIT", "");
      const { app } = await setup(tx);

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ status: "ok", commit: "unknown" });
    }));

  it("accepts a payload larger than Fastify's 1 MiB default", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, connection, settledAtLeast } = await setup(tx);

      const response = await post(app, {
        event: "MESSAGES_SET",
        instance: connection.instanceName,
        data: { bulky: "x".repeat(1.5 * 1024 * 1024) },
      });
      await settledAtLeast(1);

      expect(response.statusCode).toBe(200);
      expect(await eventCount(tx, connection.id)).toBe(1);
      expect(await conversationsOf(tx, connection.id)).toHaveLength(0);
    }));

  it("replays the same upsert three times as one conversation and one message", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, hooks, connection, settledAtLeast } = await setup(tx);
      const payload = upsertPayload({ instance: connection.instanceName });

      await post(app, payload);
      await settledAtLeast(1);
      const afterFirst = await conversationsOf(tx, connection.id);
      expect(afterFirst).toHaveLength(1); // precondition
      await post(app, payload);
      await settledAtLeast(2);
      await post(app, payload);
      await settledAtLeast(3);

      const conversations = await conversationsOf(tx, connection.id);
      expect(conversations).toHaveLength(1);
      expect(await messagesOf(tx, connection.id)).toHaveLength(1);
      expect(await eventCount(tx, connection.id)).toBe(3);
      expect(hooks).toHaveLength(1);
      // A replay must not move the thread's extrema.
      expect(conversations[0]?.lastMessageAt).toEqual(afterFirst[0]?.lastMessageAt);
      expect(conversations[0]?.startedAt).toEqual(afterFirst[0]?.startedAt);
    }));

  it("reuses one conversation when a later event uses @c.us for the same phone", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, connection, settledAtLeast } = await setup(tx);

      await post(
        app,
        upsertPayload({
          instance: connection.instanceName,
          id: "CUS-1",
          remoteJid: "5511999999999@s.whatsapp.net",
        }),
      );
      await settledAtLeast(1);
      await post(
        app,
        upsertPayload({
          instance: connection.instanceName,
          id: "CUS-2",
          remoteJid: "5511999999999@c.us",
        }),
      );
      await settledAtLeast(2);

      // One row by the (whatsapp_connection_id, chat_key) unique index, not by a
      // flat unit+phone pair the fake maintained. See note 3 in the header.
      const conversations = await conversationsOf(tx, connection.id);
      expect(conversations).toHaveLength(1);
      expect(await messagesOf(tx, connection.id)).toHaveLength(2);
      expect(conversations[0]?.chatKey).toBe("5511999999999");
      // The conflict path updates the stored JID to the latest spelling.
      expect(conversations[0]?.remoteJid).toBe("5511999999999@c.us");
    }));

  it("reuses the chat-key conversation when the JID has a device suffix", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, connection, settledAtLeast } = await setup(tx);

      await post(
        app,
        upsertPayload({
          instance: connection.instanceName,
          id: "DEV-1",
          remoteJid: "5511999999999@s.whatsapp.net",
        }),
      );
      await settledAtLeast(1);
      await post(
        app,
        upsertPayload({
          instance: connection.instanceName,
          id: "DEV-2",
          remoteJid: "5511999999999:12@s.whatsapp.net",
        }),
      );
      await settledAtLeast(2);

      const conversations = await conversationsOf(tx, connection.id);
      expect(conversations).toHaveLength(1);
      expect(conversations[0]?.chatKey).toBe("5511999999999");
      expect(await messagesOf(tx, connection.id)).toHaveLength(2);
    }));

  it("dedupes SEND_MESSAGE with the same external id and can ingest send.message alone", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, connection, settledAtLeast } = await setup(tx);

      await post(app, upsertPayload({ instance: connection.instanceName, fromMe: true }));
      await settledAtLeast(1);
      await post(
        app,
        upsertPayload({
          instance: connection.instanceName,
          event: "SEND_MESSAGE",
          fromMe: true,
        }),
      );
      await settledAtLeast(2);
      expect(await messagesOf(tx, connection.id)).toHaveLength(1);
      // Closed before the second app is built: each app subscribes its own
      // canonicalizer to the process-wide event, and two would race for the
      // second app's rows, leaving its completion signal to the first.
      await app.close();

      // A second connection stands in for the old file's second memory store:
      // SEND_MESSAGE with no prior upsert must still open the thread.
      const sendOnly = await setup(tx);
      await post(
        sendOnly.app,
        upsertPayload({
          instance: sendOnly.connection.instanceName,
          event: "SEND_MESSAGE",
          id: "SEND-ONLY",
          fromMe: true,
        }),
      );
      await sendOnly.settledAtLeast(1);

      expect(await conversationsOf(tx, sendOnly.connection.id)).toHaveLength(1);
      const sendOnlyMessages = await messagesOf(tx, sendOnly.connection.id);
      expect(sendOnlyMessages).toHaveLength(1);
      expect(sendOnlyMessages[0]?.providerTimestamp).toEqual(expectedTimestamp);
    }));

  it("keeps a single message when two ingests of the same id run concurrently", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const connection = await seedConnection(tx, { unitId: unit.id });
      const store = createIngestStore(kernel.createDb(tx, runInTransactionOnTx(tx)));
      let hooks = 0;
      offs.push(
        kernel.subscribe(messageReceived, () => {
          hooks += 1;
        }),
      );
      const payload = upsertPayload({ instance: connection.instanceName, id: "CONCURRENT" });

      await Promise.all(
        [1, 2].map(async () => {
          const { id } = await persistRawEvent(store, payload);
          await canonicalizeEvent(store, id);
        }),
      );

      // The second insert is absorbed by ON CONFLICT DO NOTHING, so it reports
      // `inserted: false` and the hook does not fire again.
      const messages = await messagesOf(tx, connection.id);
      expect(messages).toHaveLength(1);
      expect(hooks).toBeLessThanOrEqual(1);
      // Reached through the connection join, not a flat column.
      expect(messages[0]?.externalMessageId).toBe("CONCURRENT");
    }));

  it("stores non-canonical events without inbox rows and rejects 401 with no writes", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, connection, settledAtLeast } = await setup(tx);
      const instance = connection.instanceName;

      const skipped = [
        await post(app, upsertPayload({ instance, remoteJid: "120363-group@g.us", id: "G1" })),
        await post(app, upsertPayload({ instance, remoteJid: "123456789012345@lid", id: "L1" })),
        await post(app, upsertPayload({ instance: `${instance}-absent`, id: "U1" })),
        await post(app, upsertPayload({ instance, event: "MESSAGES_SET", id: "S1" })),
        await post(app, upsertPayload({ instance, messageTimestamp: null, id: "T1" })),
      ];

      await settledAtLeast(5);

      expect(skipped.every((response) => response.statusCode === 200)).toBe(true);
      // Four resolve to this connection; the unknown-instance one deliberately
      // resolves to none, so it is counted separately rather than being lost.
      expect(await eventCount(tx, connection.id)).toBe(4);
      expect(
        await tx.webhookEvent.count({
          where: { whatsappConnectionId: null, externalMessageId: "U1" },
        }),
      ).toBe(1);
      expect(await conversationsOf(tx, connection.id)).toHaveLength(0);
      expect(await messagesOf(tx, connection.id)).toHaveLength(0);

      const unauthorized = await app.inject({
        method: "POST",
        url: "/webhooks/evolution",
        payload: upsertPayload({ instance, id: "NOPE" }),
      });

      expect(unauthorized.statusCode).toBe(401);
      expect(await eventCount(tx, connection.id)).toBe(4);
    }));
});
