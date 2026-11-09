/**
 * Test design (testing-strategy)
 *
 * Setup: Fastify inject on the whole app (the auth hook and the conversations
 * module's routes) when DATABASE_URL is set. describe.skipIf(!live)
 * so a laptop without Postgres does not go red. Unique ids; no TRUNCATE
 * of existing rows.
 *
 * Spec rule (openspec/specs/conversations/conversas/spec.md unit isolation; rows keyed by
 *   `chat_key` per conversation-phone-unique — main conversas spec does not
 *   name that column until archive):
 *   List scoped to the current unit (Prisma path). Conversations of other
 *   units MUST NOT appear. Thread/send on another unit's id → 404.
 *
 * Axes
 *   A1 DATABASE_URL set vs unset (skip)
 *   A2 requested unit vs row's connection.unitId (same / other)
 *   A3 surface — list / thread GET / send POST
 *
 * Outputs: O1 200 list contains own id; O2 200 list omits other id;
 *   O3 404 thread/send; O4 skip
 *
 * Sampled-cell
 *   lists own seeded conversation     | A2 same A3 list | O1 | missing id
 *   list omits other-unit conversation| A2 other A3 list| O2 | other id present
 *   thread GET other-unit id          | A2 other A3 GET | O3 | 200
 *   send POST other-unit id           | A2 other A3 POST| O3 | 201
 *
 * Decision map (conversations module: list-conversations, list-messages, send-message)
 *   D1 list where connection.unitId   T: own row; F: other unit omitted
 *   D2 messages findFirst unit match  F: null → HTTP 404
 *   D3 enqueue findFirst unit match   F: not_found → HTTP 404
 *
 * Out of scope: memory store isolation (memory.test.ts); TRUNCATE;
 *   Nova conversa @c.us reopen (open-conversation's tests). Rows are
 *   inserted with `chatKey` (conversation-phone-unique).
 *
 * The caller is a REAL `user` row with real `user_unit` memberships, created in
 * `beforeAll` with a generated id and removed in `afterAll` before the lojas it
 * points at (memberships first: unit deletion is Restrict). It used to be
 * `seededMemoryAuth(...)`, an in-memory auth store — the last fake this file
 * built. `getUser` stays injected, because Supabase JWT validation is an
 * external port rather than a store; the token now resolves to this file's own
 * user id instead of the shared `TEST_USER_ID`, so six live files can hold
 * committed caller rows at once without colliding on one id or deleting each
 * other's.
 *
 * Moved from `apps/api/src/conversations.live.test.ts` (4A), assertions
 * unchanged; the conversations and tags stores it passed were the defaults, and
 * are the module's routes now.
 *
 * ASSERTION THAT ONLY HELD ON THE FAKE: the caller's memberships were a string
 * array handed to the fake, so the 200s and 403s below were decided from that
 * array. `user_unit.unit_id` is a foreign key to `unit`, so a membership now
 * requires the loja to exist, and the auth hook decides from rows it reads.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createFakeGetUser } from "@select-lub/core/testing";
import { withConnectRetry, seedUser } from "@select-lub/core/testing";
import { TEST_ACCESS_TOKEN } from "@select-lub/core/testing";
import { shouldRunLiveTests } from "@select-lub/core/db";

const repoRoot = resolve(import.meta.dirname, "../../..");
const envPath = resolve(repoRoot, ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const live = shouldRunLiveTests();
const instanceName = process.env.EVOLUTION_INSTANCE_NAME ?? "select-lub-poc";

describe.skipIf(!live)("live conversations list", () => {
  const runId = randomUUID();
  /** The caller: a real `user` row, not the memory auth store's literal. */
  const callerUserId = randomUUID();
  const callerEmail = `caller-${runId}@test.local`;
  const digits = runId.replace(/\D/g, "").slice(0, 8).padEnd(8, "0");
  const remoteJid = `5511${digits}@s.whatsapp.net`;
  const remoteJidB = `5512${digits}@s.whatsapp.net`;
  const externalId = `test-conv-${runId}`;
  const externalIdB = `test-conv-b-${runId}`;
  let prisma!: NonNullable<(typeof import("@select-lub/core/db"))["prisma"]>;
  let app!: Awaited<ReturnType<typeof buildApp>>;
  let unitId = "";
  let unitBId = "";
  let connectionBId = "";
  let conversationId = "";
  let conversationBId = "";

  beforeAll(async () => {
    // Migrate and seed happen once for the whole project, in this Vitest
    // config's `globalSetup`. Doing it here raced the other live files on
    // Prisma's select-then-insert `upsert` — HANDOFF.md item 5.
    const db = await import("@select-lub/core/db");
    const client = db.prisma;
    if (!client) {
      throw new Error("expected PrismaClient when DATABASE_URL is set");
    }
    prisma = withConnectRetry(client);
    const connection = await prisma.whatsAppConnection.findUniqueOrThrow({
      where: { instanceName },
    });
    unitId = connection.unitId;
    const conversation = await prisma.conversation.create({
      data: {
        whatsappConnectionId: connection.id,
        remoteJid,
        chatKey: remoteJid.replace(/\D/g, ""),
        startedAt: new Date(),
        lastMessageAt: new Date(),
        messages: {
          create: {
            externalMessageId: externalId,
            direction: "inbound",
            messageType: "text",
            textBody: "live",
            providerTimestamp: new Date(),
          },
        },
      },
    });
    conversationId = conversation.id;
    const unitB = await prisma.unit.create({ data: { name: `iso-b-${runId}` } });
    unitBId = unitB.id;
    const connectionB = await prisma.whatsAppConnection.create({
      data: { unitId: unitB.id, instanceName: `iso-b-${runId}` },
    });
    connectionBId = connectionB.id;
    const conversationB = await prisma.conversation.create({
      data: {
        whatsappConnectionId: connectionB.id,
        remoteJid: remoteJidB,
        chatKey: remoteJidB.replace(/\D/g, ""),
        startedAt: new Date(),
        lastMessageAt: new Date(),
        messages: {
          create: {
            externalMessageId: externalIdB,
            direction: "inbound",
            messageType: "text",
            textBody: "other-unit",
            providerTimestamp: new Date(),
          },
        },
      },
    });
    conversationBId = conversationB.id;
    // The caller's CRM row and memberships, committed like every other row
    // in this file and cleaned up in `afterAll` before the lojas.
    await seedUser(prisma, {
      id: callerUserId,
      units: [unitId],
      email: callerEmail,
      name: `Caller ${runId}`,
    });
    app = await buildApp({
      db: prisma,
      getUser: createFakeGetUser({
        [TEST_ACCESS_TOKEN]: { id: callerUserId, email: callerEmail },
      }),
      // Pinned so no case can reach the real Evolution instance; none of the
      // routes here reaches the probe before its 404 or its read (4A).
      channelConnected: async () => true,
    });
  }, 120_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (!prisma) {
      return;
    }
    // Memberships before the lojas they point at: unit deletion is Restrict.
    await prisma.userUnit.deleteMany({ where: { userId: callerUserId } });
    await prisma.user.deleteMany({ where: { id: callerUserId } });
    await prisma.outboxMessage.deleteMany({
      where: { conversationId: { in: [conversationId, conversationBId].filter(Boolean) } },
    });
    await prisma.message.deleteMany({
      where: { externalMessageId: { in: [externalId, externalIdB] } },
    });
    await prisma.conversation.deleteMany({
      where: { remoteJid: { in: [remoteJid, remoteJidB] } },
    });
    if (connectionBId) {
      await prisma.whatsAppConnection.deleteMany({ where: { id: connectionBId } });
    }
    if (unitBId) {
      await prisma.unit.deleteMany({ where: { id: unitBId } });
    }
  });

  it("lists the seeded-unit conversation without truncating other rows", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/conversations",
      headers: { "x-unit-id": unitId, authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    const ids = (response.json() as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toContain(conversationId);
  });

  it("does not list the other unit's conversation", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/conversations",
      headers: { "x-unit-id": unitId, authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    const ids = (response.json() as Array<{ id: string }>).map((row) => row.id);
    expect(ids).not.toContain(conversationBId);
  });

  it("returns 404 for the other unit's thread", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/conversations/${conversationBId}/messages`,
      headers: { "x-unit-id": unitId, authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 when sending to the other unit's conversation", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${conversationBId}/messages`,
      headers: { "x-unit-id": unitId, "content-type": "application/json", authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
      payload: { text: "oi" },
    });
    expect(response.statusCode).toBe(404);
  });
});
