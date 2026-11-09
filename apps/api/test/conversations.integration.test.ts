/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/api/src/conversations.test.ts` (4A), assertions unchanged.
 * These cases stay on the whole app because each needs more than one slice or
 * the auth hook: the 401s; `/channel/status` (channel's route) set against the
 * send and Nova conversa, which is the two-source rule; a send read back through
 * the thread; Nova conversa read back through the list; one 404 case spanning
 * the thread and the send. Appended from other files: #102's chat-key uniqueness
 * case (`conversations.filters.route.test.ts`) and the two media 401s
 * (`conversations.media.test.ts`). The other seventeen cases of this file are
 * the list-conversations (8), list-messages (3), send-message (4) and
 * open-conversation (2) slices' own tests.
 *
 * Setup: Fastify inject (in-process request, no TCP) against the **Prisma**
 * conversations adapter inside `withTestTransaction`, so every row below is
 * written to the worktree's Postgres and rolled back. Auth is a real `User` +
 * `UserUnit` at `TEST_USER_ID`, read by the Prisma auth store; the
 * `memberUnitIds` shortcut seeded a memory auth store and is gone.
 *
 * The channel probe is injected, so no test here can reach the real instance.
 * `buildApp`'s default wires `channelConnected: () => fetchEvolutionConnected()`
 * and this app's Vitest setup loads `.env`, so the default would issue a real
 * outbound GET to the hosted Evolution instance on every send and create.
 * The store is built with an explicit probe and this test's own
 * `instanceName`, through the documented `stores` override — the production
 * adapter, different options. Passing `instanceName` also means this file never
 * reads `EVOLUTION_INSTANCE_NAME` and never repoints the shared connection row
 * that carries that name.
 *
 * Every row read here is created here. A package-scoped `pnpm --filter <pkg>
 * test` skips the root vitest globalSetup that migrates and seeds, so
 * demo-seed tables are empty under that invocation while a worktree database
 * and a root CI run are both full. Nothing below reads a demo-seed row, so the
 * file is correct under either.
 *
 * WHAT ONLY HELD ON THE FAKE
 *
 *   1. **Connectivity had one source; it really has two, and the routes split
 *      across them.** The fake's `setConnected(false)` flipped a single flag
 *      that drove every connectivity outcome. On the Prisma adapter there are
 *      two independent sources:
 *
 *        - the STORED COLUMN `whatsapp_connection.connection_state` drives
 *          `channelStatus` and `create` (Nova conversa);
 *        - the LIVE PROBE `connectedNow()` — in production a GET to Evolution —
 *          drives `enqueue` (send text), `enqueueMedia` and `fetchMedia`.
 *
 *      So a dropped session refuses a SEND while Nova conversa still works, and
 *      the screen still reads Conectado, until something writes the column back.
 *      The fake could not represent that state at all. Found by getting it
 *      wrong: the Nova-conversa refusal `it` first moved the probe and returned
 *      201. The adapter is right and specified — the conversas spec says "POST
 *      /conversations requires that column to read CONNECTED before it creates
 *      or reopens a row" — so the test changed, not the code. Each refusal `it`
 *      now moves the source its own route reads and holds the other one up, so
 *      a test that moved the wrong one cannot pass by accident, and one `it`
 *      pins the disagreement in both directions at once.
 *
 *   2. **Scoping is a join.** `Conversation` has no `unitId` column; the
 *      adapter scopes with `whatsappConnection: { unitId }`. The fake compared
 *      a flat field, so "in this unit" was a property rather than a join, and a
 *      conversation could exist in a unit with no connection at all — a state
 *      the schema forbids, since `whatsappConnectionId` is a required FK.
 *
 *   3. **`contactLabel` needs a real customer.** The fake accepted
 *      `seedConversation({ customerName })` as a field on the conversation row.
 *      There is no such column: the adapter reads `conversation.customerId`,
 *      then looks the name up in `customer`. The two label `it`s now create a
 *      `Customer` and link it, which is what production does.
 *
 * Spec rule (openspec/specs/conversations/conversas/spec.md):
 *   List scoped to the unit, newest lastMessageAt first.
 *   Thread ordered by providerTimestamp (WhatsApp time).
 *   Send goes through the outbox. Empty text → 400. Channel down → 409.
 *   HTML-like text is returned unchanged (not interpreted as markup).
 *
 * Partitions (one numbered group = HTTP outcomes the spec treats the same):
 *
 *   P1 VALID   — empty unit: GET list → []
 *   P2 VALID   — two conversations: later lastMessageAt listed first
 *   P3 VALID   — contactLabel is the phone when no customer is linked
 *   P4 VALID   — thread textBody is the raw HTML-like string
 *   P5 VALID   — thread order is providerTimestamp, not insert order
 *   P6 INVALID — send text "  " → 400, zero outbox rows
 *   P7 VALID   — send text "resposta" → 201, body appears in thread
 *   P8 INVALID — probe says disconnected → 409
 *   P11 VALID  — GET /channel/status follows the stored column
 *   P9 INVALID — no access token → 401
 *   P10 INVALID — known unit, unknown conversation id → thread/send 404
 *   P12 VALID   — POST /conversations while the probe is up → 201 create, then
 *                 200 reopen on the same phone (still one row)
 *   P13 INVALID — POST /conversations while the probe is down → 409, no row
 *   P14 INVALID — POST /conversations with an empty phone
 *   P15 VALID   — GET thread: seeded outbound keeps providerStatus /
 *                 contentUnavailable; inbound without them omits invented status
 *   P16 VALID   — stored column and live probe disagree, and each drives its own
 *                 route (new; unrepresentable on the fake)
 *
 * Output partitions:
 *   O1 — 200 list [] (P1)
 *   O2 — 200 list newest-first (P2), contactLabel (P3)
 *   O3 — 200 thread: raw text, WhatsApp-time order (P4/P5); optional
 *        providerStatus / contentUnavailable (P15)
 *   O4 — 400 empty send (P6)      O5 — 201 queued send (P7)
 *   O6 — 409 channel down (P8)    O7 — 404 thread/send (P10)
 *   O8 — Nova conversa create-or-open (P12/P13/P14)
 *   O9 — one outbox on reuse; O10 — two outbox when the key is omitted
 *
 * Limits (boundary value analysis):
 *   lastMessageAt 2026-08-01 vs 2026-08-02 (newest-first).
 *   send "  " (trim then min(1) fails) vs "resposta".
 *   insert order is the reverse of WhatsApp time (P5).
 *
 * Decision map (the conversation slices, formerly conversations/routes.ts)
 *   list tagIds.length T: tags.integration.test.ts filter; F: unfiltered list its
 *   Nova conversa created vs reopen ternary T: P12 first 201; F: P12 repeat 200
 *   messages null → 404; enqueue not_found → 404; channel_down → 409;
 *   201 queued. Media handlers: the fetch-media and send-media slices.
 *   create channel_down → 409 `{ code: "channel_not_connected" }`;
 *   send-text channel_down → 409 `{ state: "DISCONNECTED" }` (two different
 *   bodies on the same condition, both route literals).
 *
 * Decision map (the slices' queries, formerly conversations/prisma.ts)
 *   `channelStatus` connection row present / absent — P11 present; absent is
 *     not sampled here (it is the disconnected tour's own config).
 *   `connectedNow()` T — the 201 its; F — P8/P13 and the media suite.
 *   `enqueue` idempotencyKey present / absent — the two outbox its.
 *   `create` existing row at [connectionId, chatKey] — P12 reopen.
 *
 * Not in this file: other-unit isolation across two connections
 * (list-conversations' tests); live Postgres without the harness
 * (conversations.live.test.ts); media (the fetch-media and send-media slices).
 */
import { expect, it } from "vitest";
import { conversationSummaryListSchema } from "@select-lub/shared-types";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import type { DbClient } from "@select-lub/core/db";
import {
  describeWithDatabase,
  multipartPayload,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  seedUser,
  withTestTransaction,
} from "@select-lub/core/testing";
import { buildApp } from "../src/app.js";
import { createFakeGetUser, TEST_ACCESS_TOKEN, TEST_USER_ID } from "@select-lub/core/testing";

function auth(unitId?: string) {
  return {
    authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
    ...(unitId ? { "x-unit-id": unitId } : {}),
  };
}

function jsonAuth(unitId: string) {
  return { ...auth(unitId), "content-type": "application/json" };
}

function outboxCount(tx: DbClient, conversationId: string) {
  return tx.outboxMessage.count({ where: { conversationId } });
}

/**
 * Builds the app on the test transaction, pinned to this test's connection and
 * to a probe the test controls.
 *
 * `connected` is a getter rather than a boolean so a single test can flip the
 * LIVE answer mid-run without rebuilding the app — which is the only way to
 * show it moving independently of the stored column.
 */
async function buildAppOn(
  tx: DbClient,
  input: { instanceName: string; connected?: () => boolean },
) {
  const connected = input.connected ?? (() => true);
  return buildApp({
    db: tx,
    runInTransaction: runInTransactionOnTx(tx),
    getUser: createFakeGetUser(),
    // Nova conversa and `/channel/status` both read this instance.
    evolutionInstanceName: input.instanceName,
    channelConnected: async () => connected(),
  });
}

/** One unit, one CONNECTED connection, a member user, and an app bound to them. */
async function setup(tx: DbClient, options: { connected?: () => boolean } = {}) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  await seedUser(tx, { id: TEST_USER_ID, units: [unit.id] });
  const app = await buildAppOn(tx, { instanceName: connection.instanceName, ...options });
  return { unit, connection, app };
}

describeWithDatabase("conversations HTTP (real adapter)", () => {
  const db = () => prisma as PrismaClient;

  it("queues a non-empty send", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, connection, app } = await setup(tx);
      const conversation = await seedConversation(tx, { connectionId: connection.id });

      const queued = await app.inject({
        method: "POST",
        url: `/conversations/${conversation.id}/messages`,
        headers: jsonAuth(unit.id),
        payload: { text: "resposta" },
      });
      expect(queued.statusCode).toBe(201);

      const afterSend = await app.inject({
        method: "GET",
        url: `/conversations/${conversation.id}/messages`,
        headers: auth(unit.id),
      });
      expect(
        afterSend.json().some((row: { textBody: string }) => row.textBody === "resposta"),
      ).toBe(true);
      // The row is really in the outbox, not only in the response body.
      expect(await outboxCount(tx, conversation.id)).toBe(1);
      await app.close();
    }));

  it("reports channel status from the stored connection column", () =>
    withTestTransaction(db(), async (tx) => {
      // The fake flipped one flag for this route AND the send guard. Here the
      // route reads the COLUMN, so the column is what moves — and the probe is
      // held at `true` throughout to prove the route is not reading it.
      const unit = await seedUnit(tx);
      const connection = await seedConnection(tx, { unitId: unit.id });
      await seedUser(tx, { id: TEST_USER_ID, units: [unit.id] });
      const app = await buildAppOn(tx, {
        instanceName: connection.instanceName,
        connected: () => true,
      });

      const up = await app.inject({ method: "GET", url: "/channel/status", headers: auth() });
      expect(up.statusCode).toBe(200);
      expect(up.json()).toEqual({ state: "CONNECTED" });

      await tx.whatsAppConnection.update({
        where: { id: connection.id },
        data: { connectionState: "DISCONNECTED" },
      });

      const down = await app.inject({ method: "GET", url: "/channel/status", headers: auth() });
      expect(down.statusCode).toBe(200);
      expect(down.json()).toEqual({ state: "DISCONNECTED" });
      await app.close();
    }));

  it("lets the stored column and the live probe disagree, each driving its own route", () =>
    withTestTransaction(db(), async (tx) => {
      // P16, and the sharpest of the three fake-only assertions: this state is
      // not merely one the fake would have got wrong, it is one the fake could
      // not REPRESENT, because it had a single flag for both. Stored state says
      // CONNECTED while the live probe says down — exactly what a dropped
      // session looks like before anything writes the column back.
      const { unit, connection, app } = await setup(tx, { connected: () => false });
      const conversation = await seedConversation(tx, { connectionId: connection.id });

      // Precondition: the stored column really is CONNECTED, so the 409 below
      // cannot be the column talking.
      expect(
        (
          await tx.whatsAppConnection.findUnique({
            where: { id: connection.id },
            select: { connectionState: true },
          })
        )?.connectionState,
      ).toBe("CONNECTED");

      const status = await app.inject({ method: "GET", url: "/channel/status", headers: auth() });
      expect(status.json()).toEqual({ state: "CONNECTED" });

      // Probe-driven: send refuses.
      const send = await app.inject({
        method: "POST",
        url: `/conversations/${conversation.id}/messages`,
        headers: jsonAuth(unit.id),
        payload: { text: "vai falhar" },
      });
      expect(send.statusCode).toBe(409);
      expect(await outboxCount(tx, conversation.id)).toBe(0);

      // Column-driven, in the SAME state: Nova conversa still succeeds. This is
      // the other half of the split, and it is what makes the 409 above a
      // distinction rather than "everything refuses when the probe is down".
      const created = await app.inject({
        method: "POST",
        url: "/conversations",
        headers: jsonAuth(unit.id),
        payload: { phone: "11955550000" },
      });
      expect(created.statusCode).toBe(201);
      expect(
        await tx.conversation.count({
          where: { whatsappConnectionId: connection.id, chatKey: "11955550000" },
        }),
      ).toBe(1);
      await app.close();
    }));

  it("returns 401 when the conversation list has no access token", () =>
    withTestTransaction(db(), async (tx) => {
      const { app } = await setup(tx);

      expect((await app.inject({ method: "GET", url: "/conversations" })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: "GET", url: "/conversations/any/messages" })).statusCode,
      ).toBe(401);
      const send = await app.inject({
        method: "POST",
        url: "/conversations/any/messages",
        headers: { "content-type": "application/json" },
        payload: { text: "oi" },
      });
      expect(send.statusCode).toBe(401);
      await app.close();
    }));

  it("returns 404 for an unknown conversation id on a known unit", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, app } = await setup(tx);

      const thread = await app.inject({
        method: "GET",
        url: "/conversations/missing-id/messages",
        headers: auth(unit.id),
      });
      expect(thread.statusCode).toBe(404);

      const send = await app.inject({
        method: "POST",
        url: "/conversations/missing-id/messages",
        headers: jsonAuth(unit.id),
        payload: { text: "oi" },
      });
      expect(send.statusCode).toBe(404);
      await app.close();
    }));

  it("POSTs Nova conversa once and reopens it on a repeat phone", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, connection, app } = await setup(tx);

      const created = await app.inject({
        method: "POST",
        url: "/conversations",
        headers: jsonAuth(unit.id),
        payload: { phone: "(11) 99999-0000" },
      });
      expect(created.statusCode).toBe(201);

      const reopened = await app.inject({
        method: "POST",
        url: "/conversations",
        headers: jsonAuth(unit.id),
        payload: { phone: "11999990000" },
      });
      // 201 created vs 200 existing is the route's own distinction, so the
      // reopen pins 200 exactly; the 201 above is the positive control that
      // makes it a distinction rather than a constant.
      expect(reopened.statusCode).toBe(200);
      expect(reopened.json().id).toBe(created.json().id);

      expect(
        await tx.conversation.count({
          where: { whatsappConnectionId: connection.id, chatKey: "11999990000" },
        }),
      ).toBe(1);
      const list = await app.inject({
        method: "GET",
        url: "/conversations",
        headers: auth(unit.id),
      });
      expect(list.json()).toHaveLength(1);
      await app.close();
    }));

});

/**
 * #102's chat-key uniqueness scenario, moved from
 * `apps/api/src/conversations.filters.route.test.ts` (4A), assertions
 * unchanged. It lists and then opens Nova conversa, two slices, so it stays on
 * the whole app.
 *
 * WHAT ONLY HELD ON THE FAKE: the schema enforces
 * `@@unique([whatsappConnectionId, chatKey])`; the fake deduped on unit + phone.
 * Those agree only while a loja has one connection. Nova conversa resolves the
 * connection by the configured instance name (PR #89), never by unit.
 */
describeWithDatabase("one chat key per connection (real adapter)", () => {
  const db = () => prisma as PrismaClient;

  function idsOf(response: { json: () => unknown }) {
    return conversationSummaryListSchema.parse(response.json()).map((row) => row.id);
  }

  it("keeps one chat key per connection, and reopens rather than duplicating on the same one", () =>
    withTestTransaction(db(), async (tx) => {
      // Task 2.3. The schema's key is [whatsappConnectionId, chatKey]; the fake
      // deduped on unit + phone. The first half below is what that disagreement
      // gets wrong — two connections in one unit, same phone, two legitimate
      // rows — and the second half is the half both agreed on.
      const unit = await seedUnit(tx);
      const first = await seedConnection(tx, { unitId: unit.id });
      const second = await seedConnection(tx, { unitId: unit.id });
      await seedUser(tx, { id: TEST_USER_ID, units: [unit.id] });
      const shared = "11922220001";

      const onFirst = await seedConversation(tx, { connectionId: first.id, chatKey: shared });
      const onSecond = await seedConversation(tx, { connectionId: second.id, chatKey: shared });

      expect(onFirst.id).not.toBe(onSecond.id);
      expect(onFirst.chatKey).toBe(onSecond.chatKey);
      expect(onFirst.whatsappConnectionId).not.toBe(onSecond.whatsappConnectionId);

      // Both are real rows the unit can see. A unit+phone dedupe would have
      // permitted only one of them.
      const app = await buildAppOn(tx, { instanceName: first.instanceName });
      const listed = await app.inject({ method: "GET", url: "/conversations", headers: auth(unit.id) });
      expect(listed.statusCode).toBe(200);
      expect([...idsOf(listed)].sort()).toEqual([onFirst.id, onSecond.id].sort());

      // Positive control first, so the 200 below is a distinction and not a
      // constant: a key this connection has never seen is 201 Created.
      const fresh = await app.inject({
        method: "POST",
        url: "/conversations",
        headers: jsonAuth(unit.id),
        payload: { phone: "11933330009" },
      });
      expect(fresh.statusCode).toBe(201);

      // Same key on the SAME connection: the route reports the existing
      // conversation instead of creating a second — 201 created, 200 existing.
      // The app is bound to `first`, so that is the connection the create
      // resolves, by instance name, which is the resolution PR #89 corrected.
      const reopened = await app.inject({
        method: "POST",
        url: "/conversations",
        headers: jsonAuth(unit.id),
        payload: { phone: shared },
      });

      expect(reopened.statusCode).toBe(200);
      expect((reopened.json() as { id?: string }).id).toBe(onFirst.id);
      expect(await tx.conversation.count({ where: { whatsappConnectionId: first.id, chatKey: shared } })).toBe(1);
      // And the other connection's row is untouched by the reopen, which is the
      // half a unit+phone dedupe would have collapsed.
      expect(await tx.conversation.count({ where: { whatsappConnectionId: second.id, chatKey: shared } })).toBe(1);
      await app.close();
    }));
});

/**
 * The three media cases that need the whole app, moved from
 * `apps/api/src/conversations.media.test.ts` (4A), assertions unchanged: the
 * two 401s come from the auth hook, and the queued-bytes case sends through
 * send-media and reads back through fetch-media. The other sixteen are the
 * fetch-media (8), send-media (7) and send-message (1) slices' own tests.
 *
 * The fake Evolution is the app's `fetchMedia` PORT — an external system, not a
 * store — and records every call; the LIVE probe is pinned up.
 */
describeWithDatabase("conversations media HTTP (real adapter)", () => {
  const db = () => prisma as PrismaClient;
  const FAKE_IMAGE = Buffer.from("fake-image-bytes");
  const imageForm = () =>
    multipartPayload({ messageType: "image" }, { filename: "foto.jpg", contentType: "image/jpeg", body: FAKE_IMAGE });

  /** One loja, one connection, a member user, and an app with a recording media port. */
  async function mediaSetup(tx: DbClient, media: () => Promise<{ ok: false }> | undefined = () => undefined) {
    const unit = await seedUnit(tx);
    const connection = await seedConnection(tx, { unitId: unit.id });
    await seedUser(tx, { id: TEST_USER_ID, units: [unit.id] });
    const calls: string[] = [];
    const app = await buildApp({
      db: tx,
      runInTransaction: runInTransactionOnTx(tx),
      getUser: createFakeGetUser(),
      evolutionInstanceName: connection.instanceName,
      channelConnected: async () => true,
      fetchMedia: async (call) => {
        calls.push(call.externalMessageId);
        return (await media()) ?? { ok: true, bytes: FAKE_IMAGE, mimeType: "image/jpeg", fileName: "foto.jpg" };
      },
    });
    return { unit, connection, app, calls };
  }

  it("returns 401 for media GET when the request has no access token", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, calls } = await mediaSetup(tx);

      const response = await app.inject({ method: "GET", url: "/conversations/any/messages/any/media" });

      expect(response.statusCode).toBe(401);
      expect(calls).toHaveLength(0);
      await app.close();
    }));

  it("returns 401 for media POST when the request has no access token", () =>
    withTestTransaction(db(), async (tx) => {
      const { connection, app } = await mediaSetup(tx);
      const conversation = await seedConversation(tx, { connectionId: connection.id });
      const form = imageForm();

      const response = await app.inject({
        method: "POST",
        url: `/conversations/${conversation.id}/messages/media`,
        headers: { ...form.headers },
        payload: form.payload,
      });

      expect(response.statusCode).toBe(401);
      expect(await outboxCount(tx, conversation.id)).toBe(0);
      await app.close();
    }));

  it("returns queued outbox media bytes without calling the port", () =>
    withTestTransaction(db(), async (tx) => {
      const { unit, connection, app, calls } = await mediaSetup(tx, async () => ({ ok: false }));
      const conversation = await seedConversation(tx, { connectionId: connection.id });
      const form = imageForm();

      const queued = await app.inject({
        method: "POST",
        url: `/conversations/${conversation.id}/messages/media`,
        headers: { ...auth(unit.id), ...form.headers },
        payload: form.payload,
      });
      expect(queued.statusCode).toBe(201);
      const body = queued.json() as { id: string };

      // The branch that serves these bytes is `NOT: { status: "confirmed" }`, so
      // assert the status the fixture actually has rather than assuming it.
      expect(
        (await tx.outboxMessage.findUnique({ where: { id: body.id }, select: { status: true } }))?.status,
      ).toBe("queued");

      const response = await app.inject({
        method: "GET",
        url: `/conversations/${conversation.id}/messages/${body.id}/media`,
        headers: auth(unit.id),
      });

      expect(response.statusCode).toBe(200);
      expect(Buffer.from(response.rawPayload).equals(FAKE_IMAGE)).toBe(true);
      // The port would have answered `{ ok: false }`, so a 200 proves the bytes
      // came from the outbox row and not from Evolution.
      expect(calls).toHaveLength(0);
      await app.close();
    }));
});
