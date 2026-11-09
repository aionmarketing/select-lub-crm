/**
 * Test design (testing-strategy)
 *
 * Setup: Fastify inject + Prisma reports when DATABASE_URL is set.
 * Unique ids; teardown deletes only those rows (no TRUNCATE).
 *
 * Oracle: relatorios spec — report builds from stored first_inbound_at
 * in the current unit. This file samples the Prisma adapter between units
 * (HTTP + Postgres), not every aggregate branch (aggregate.test.ts).
 *
 * Axes
 *   A1 DATABASE_URL set vs unset (skip)
 *   A2 requested unit vs row connection.unitId (same / other)
 *   A3 period — Aug 2026 (may include leftover novas) vs 2099-06 unique window
 *
 * Outputs: O1 200 count ≥ 1; O2 200 count === 1 in unique window; O3 skip
 *
 * Sampled-cell
 *   inserted Aug row counted        | A3 Aug A2 same  | O1 | 0 novas or truncate
 *   unique window hides other unit  | A3 2099 A2 other| O2 | count 2 as unit A
 *   unique window counts other unit | A3 2099 A2 same | O2 | count 0 as unit B
 *
 * Decision map
 *   describe.skipIf(!live) T: skipped when DATABASE_URL unset
 *   prisma.ts findMany where connection.unitId — T: own nova; F: other unit
 *   header T via x-unit-id; instanceName F not sampled (needs unset env);
 *   sourceType omitted (todas).
 *
 * Out of scope: origin SQL filter (prisma.test.ts); wiping inbox.
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
 * ASSERTION THAT ONLY HELD ON THE FAKE: the caller's memberships were a string
 * array handed to the fake, so the 200s and 403s below were decided from that
 * array. `user_unit.unit_id` is a foreign key to `unit`, so a membership now
 * requires the loja to exist, and the auth hook decides from rows it reads.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reportResultSchema } from "@select-lub/shared-types";
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

describe.skipIf(!live)("live reports summary", () => {
  const runId = randomUUID();
  /** The caller: a real `user` row, not the memory auth store's literal. */
  const callerUserId = randomUUID();
  const callerEmail = `caller-${runId}@test.local`;
  const digits = runId.replace(/\D/g, "").slice(0, 8).padEnd(8, "0");
  const remoteJid = `5519${digits}@s.whatsapp.net`;
  const remoteJidIso = `5517${digits}@s.whatsapp.net`;
  const remoteJidIsoB = `5516${digits}@s.whatsapp.net`;
  let prisma!: NonNullable<(typeof import("@select-lub/core/db"))["prisma"]>;
  let app!: Awaited<ReturnType<typeof buildApp>>;
  let unitId = "";
  let unitBId = "";
  let connectionBId = "";
  let conversationId = "";
  let conversationIsoId = "";
  let conversationIsoBId = "";

  beforeAll(async () => {
    // Migrate and seed happen once for the whole project, in this Vitest
    // config's `globalSetup`. This file's copy was the worst offender: it
    // re-seeded the shared database MID-SUITE, underneath live files that were
    // already running, which is why the set of failures moved between identical
    // runs while each file passed alone — HANDOFF.md item 5.
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
    const inbound = new Date("2026-08-15T15:00:00.000Z");
    const conversation = await prisma.conversation.create({
      data: {
        whatsappConnectionId: connection.id,
        remoteJid,
        chatKey: remoteJid.replace(/\D/g, ""),
        startedAt: inbound,
        firstInboundAt: inbound,
        firstOutboundAt: new Date("2026-08-15T16:00:00.000Z"),
        lastMessageAt: inbound,
      },
    });
    conversationId = conversation.id;
    const unitB = await prisma.unit.create({ data: { name: `rpt-b-${runId}` } });
    unitBId = unitB.id;
    const connectionB = await prisma.whatsAppConnection.create({
      data: { unitId: unitB.id, instanceName: `rpt-b-${runId}` },
    });
    connectionBId = connectionB.id;
    const isoInbound = new Date("2099-06-15T15:00:00.000Z");
    const conversationIso = await prisma.conversation.create({
      data: {
        whatsappConnectionId: connection.id,
        remoteJid: remoteJidIso,
        chatKey: remoteJidIso.replace(/\D/g, ""),
        startedAt: isoInbound,
        firstInboundAt: isoInbound,
        firstOutboundAt: new Date("2099-06-15T16:00:00.000Z"),
        lastMessageAt: isoInbound,
      },
    });
    conversationIsoId = conversationIso.id;
    const conversationIsoB = await prisma.conversation.create({
      data: {
        whatsappConnectionId: connectionB.id,
        remoteJid: remoteJidIsoB,
        chatKey: remoteJidIsoB.replace(/\D/g, ""),
        startedAt: isoInbound,
        firstInboundAt: isoInbound,
        firstOutboundAt: new Date("2099-06-15T16:00:00.000Z"),
        lastMessageAt: isoInbound,
      },
    });
    conversationIsoBId = conversationIsoB.id;
    // The caller's CRM row and memberships, committed like every other row
    // in this file and cleaned up in `afterAll` before the lojas.
    await seedUser(prisma, {
      id: callerUserId,
      units: [unitId, unitBId],
      email: callerEmail,
      name: `Caller ${runId}`,
    });
    app = await buildApp({
      db: prisma,
      getUser: createFakeGetUser({
        [TEST_ACCESS_TOKEN]: { id: callerUserId, email: callerEmail },
      }),
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
    await prisma.conversation.deleteMany({
      where: {
        id: {
          in: [conversationId, conversationIsoId, conversationIsoBId].filter(Boolean),
        },
      },
    });
    if (connectionBId) {
      await prisma.whatsAppConnection.deleteMany({ where: { id: connectionBId } });
    }
    if (unitBId) {
      await prisma.unit.deleteMany({ where: { id: unitBId } });
    }
  });

  it("builds a report from inserted rows without truncating other data", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/reports/conversations?periodStart=2026-08-01T00:00:00.000Z&periodEnd=2026-09-01T00:00:00.000Z&granularity=day",
      headers: { "x-unit-id": unitId, authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    const body = reportResultSchema.parse(JSON.parse(response.body));
    expect(body.newConversationCount).toBeGreaterThanOrEqual(1);
  });

  it("does not count the other unit's nova in a unique period", async () => {
    const query =
      "periodStart=2099-06-01T03:00:00.000Z&periodEnd=2099-07-01T03:00:00.000Z&granularity=day";
    const asA = await app.inject({
      method: "GET",
      url: `/reports/conversations?${query}`,
      headers: { "x-unit-id": unitId, authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
    });
    const asB = await app.inject({
      method: "GET",
      url: `/reports/conversations?${query}`,
      headers: { "x-unit-id": unitBId, authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
    });

    expect(asA.statusCode).toBe(200);
    expect(asB.statusCode).toBe(200);
    expect(reportResultSchema.parse(JSON.parse(asA.body)).newConversationCount).toBe(1);
    expect(reportResultSchema.parse(JSON.parse(asB.body)).newConversationCount).toBe(1);
  });
});
