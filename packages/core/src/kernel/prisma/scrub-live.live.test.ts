/**
 * Test design (testing-strategy)
 *
 * Setup: live Prisma against DATABASE_URL. `shouldRunLiveTests` at module
 * scope — unset skips; a non-loopback host throws (task 3.4 / repo-foundation
 * "fail not skip"). Serial with other db live files (`fileParallelism: false`).
 *
 * Spec (demo-seed — "Live ingest can be scrubbed without dropping phones"):
 *   Delete LIVE messages, outbox on those conversations, webhook events for
 *   the live instance. Keep conversations and SEED messages. Re-run is a no-op.
 *
 * Partitions:
 *   P1 mixed origins — SEED + LIVE on one conversation
 *   P2 second run    — nothing live remains
 *
 * Outputs: O1 SEED count unchanged, LIVE 0, conversation still there;
 *   O2 second run deletes 0
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { shouldRunLiveTests } from "./live-test-gate.js";
import { MESSAGE_ORIGIN_LIVE, MESSAGE_ORIGIN_SEED } from "../../shared/message-origin.js";
import { scrubLiveDataset } from "./scrub-live.js";

const envPath = resolve(import.meta.dirname, "../../../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const hasDatabase = shouldRunLiveTests();

describe.skipIf(!hasDatabase)("live scrub", () => {
  const prisma = new PrismaClient();
  const suffix = `scrub-${Date.now()}`;
  const instanceName = `scrub-live-${suffix}`;
  const conversationId = `scrub-conv-${suffix}`;

  afterAll(async () => {
    await prisma.outboxMessage.deleteMany({ where: { conversationId } });
    await prisma.message.deleteMany({ where: { conversationId } });
    await prisma.conversation.deleteMany({ where: { id: conversationId } });
    await prisma.webhookEvent.deleteMany({
      where: { whatsappConnection: { instanceName } },
    });
    await prisma.whatsAppConnection.deleteMany({ where: { instanceName } });
    await prisma.unit.deleteMany({ where: { name: `scrub-unit-${suffix}` } });
    await prisma.$disconnect();
  });

  it("removes LIVE traffic and keeps the conversation and SEED thread", async () => {
    const unit = await prisma.unit.create({ data: { name: `scrub-unit-${suffix}` } });
    const connection = await prisma.whatsAppConnection.create({
      data: {
        instanceName,
        unitId: unit.id,
        provider: "EVOLUTION_BAILEYS",
        connectionState: "CONNECTED",
      },
    });
    const now = new Date();
    await prisma.conversation.create({
      data: {
        id: conversationId,
        whatsappConnectionId: connection.id,
        chatKey: "5519000000000",
        remoteJid: "5519000000000@s.whatsapp.net",
        startedAt: now,
        lastMessageAt: now,
        firstInboundAt: now,
      },
    });
    await prisma.message.create({
      data: {
        id: `${conversationId}-seed`,
        conversationId,
        externalMessageId: `seed:${conversationId}:1`,
        direction: "inbound",
        messageType: "text",
        textBody: "thread falsa",
        providerTimestamp: now,
        origin: MESSAGE_ORIGIN_SEED,
      },
    });
    await prisma.message.create({
      data: {
        id: `${conversationId}-live`,
        conversationId,
        externalMessageId: `${conversationId}-ext-live`,
        direction: "inbound",
        messageType: "text",
        textBody: "mensagem real",
        providerTimestamp: now,
        origin: MESSAGE_ORIGIN_LIVE,
      },
    });
    await prisma.outboxMessage.create({
      data: {
        conversationId,
        status: "queued",
        textBody: "fila",
      },
    });
    await prisma.webhookEvent.create({
      data: {
        payload: { id: suffix },
        status: "processed",
        whatsappConnectionId: connection.id,
      },
    });

    const seedBefore = await prisma.message.count({
      where: { conversationId, origin: MESSAGE_ORIGIN_SEED },
    });

    const first = await scrubLiveDataset(prisma, { liveInstanceName: instanceName });

    expect(first.deletedMessages).toBeGreaterThanOrEqual(1);
    expect(first.deletedOutbox).toBeGreaterThanOrEqual(1);
    expect(first.deletedWebhookEvents).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.message.count({ where: { conversationId, origin: MESSAGE_ORIGIN_SEED } }),
    ).toBe(seedBefore);
    expect(
      await prisma.message.count({ where: { conversationId, origin: { not: MESSAGE_ORIGIN_SEED } } }),
    ).toBe(0);
    expect(await prisma.conversation.count({ where: { id: conversationId } })).toBe(1);
    expect(await prisma.outboxMessage.count({ where: { conversationId } })).toBe(0);

    const second = await scrubLiveDataset(prisma, { liveInstanceName: instanceName });
    expect(second.deletedMessages).toBe(0);
    expect(second.deletedOutbox).toBe(0);
    expect(second.deletedWebhookEvents).toBe(0);
  }, 60_000);
});
