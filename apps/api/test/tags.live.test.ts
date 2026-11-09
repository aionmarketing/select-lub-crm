/**
 * Test design (testing-strategy)
 *
 * Setup: Fastify inject + Prisma when DATABASE_URL is set. Unique ids;
 * delete only rows this file created. skipIf when URL unset so CI/laptops
 * without Postgres stay green.
 *
 * Oracle: tags-templates persist per unit + inbox AND filter.
 *
 * Axes
 *   A1 DATABASE_URL set vs unset (skip)
 *   A2 create tag → apply → list filter includes the conversation
 *
 * Out of scope: the tag slices' own cases; TRUNCATE.
 *   Conversation rows use `chatKey` (conversation-phone-unique).
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
 * Moved from `apps/api/src/tags.live.test.ts` (4A), assertions unchanged; the
 * conversations and tags stores it passed were the defaults, and are the
 * module's routes now.
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
import { conversationSummaryListSchema } from "@select-lub/shared-types";
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

describe.skipIf(!live)("live tags apply and filter", () => {
  const runId = randomUUID();
  /** The caller: a real `user` row, not the memory auth store's literal. */
  const callerUserId = randomUUID();
  const callerEmail = `caller-${runId}@test.local`;
  const digits = runId.replace(/\D/g, "").slice(0, 8).padEnd(8, "0");
  const remoteJid = `5513${digits}@s.whatsapp.net`;
  const externalId = `test-tag-${runId}`;
  let prisma!: NonNullable<(typeof import("@select-lub/core/db"))["prisma"]>;
  let app!: Awaited<ReturnType<typeof buildApp>>;
  let unitId = "";
  let conversationId = "";
  let tagId = "";

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
            textBody: "tag-live",
            providerTimestamp: new Date(),
          },
        },
      },
    });
    conversationId = conversation.id;
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
    if (tagId) {
      await prisma.conversationTag.deleteMany({ where: { tagId } });
      await prisma.tag.deleteMany({ where: { id: tagId } });
    }
    await prisma.message.deleteMany({ where: { externalMessageId: externalId } });
    await prisma.conversation.deleteMany({ where: { remoteJid } });
  });

  it("creates a tag, applies it, and filters the list to that conversation", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/tags",
      headers: { "x-unit-id": unitId, "content-type": "application/json", authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
      payload: { name: `live-${runId.slice(0, 8)}`, color: "primary" },
    });
    expect(created.statusCode).toBe(201);
    tagId = created.json().id as string;

    const applied = await app.inject({
      method: "POST",
      url: `/conversations/${conversationId}/tags/${tagId}`,
      headers: { "x-unit-id": unitId, authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
    });
    expect(applied.statusCode).toBe(200);

    const listed = await app.inject({
      method: "GET",
      url: `/conversations?tagId=${tagId}`,
      headers: { "x-unit-id": unitId, authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
    });
    expect(listed.statusCode).toBe(200);
    const rows = conversationSummaryListSchema.parse(listed.json());
    expect(rows.some((row) => row.id === conversationId)).toBe(true);
    expect(rows.find((row) => row.id === conversationId)?.tags).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: tagId })]),
    );
  });
});
