/**
 * Moved from apps/worker/src/ingest/status.live.test.ts (adopt-modular-vertical-slices
 * 4A), assertion unchanged; the store is conversations' createIngestStore over the
 * shared client, under module_conversations and module_channel.
 *
 * Test design (testing-strategy)
 *
 * Setup: live Prisma when DATABASE_URL is set. skipIf otherwise.
 * Insert one outbound-shaped message, apply delivered → read → late
 * delivered, then delete only this run's rows.
 *
 * Oracle: message-status-updates task 2.5 — Prisma adapter monotonic
 * write; late delivered after read stays read.
 *
 * Out of scope: memory ladder (status.test.ts); HTTP serialization.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/kernel/db.js";
import { canonicalizeEvent, createIngestStore, persistRawEvent } from "../src/modules/conversations/index.js";
import { statusUpdatePayload, upsertPayload, withConnectRetry } from "../src/testing/index.js";
import { shouldRunLiveTests } from "@select-lub/core/db";

const repoRoot = resolve(import.meta.dirname, "../../..");
const envPath = resolve(repoRoot, ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const live = shouldRunLiveTests();

describe.skipIf(!live)("live Prisma provider status", () => {
  const runId = randomUUID();
  const externalId = `test-${runId}-status`;
  const digits = runId.replace(/\D/g, "").slice(0, 8).padEnd(8, "0");
  const remoteJid = `5511${digits}@s.whatsapp.net`;
  const instanceName = process.env.EVOLUTION_INSTANCE_NAME ?? "select-lub-poc";
  let prisma!: NonNullable<(typeof import("@select-lub/core/db"))["prisma"]>;

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
  }, 120_000);

  afterAll(async () => {
    if (!prisma) {
      return;
    }
    await prisma.message.deleteMany({ where: { externalMessageId: externalId } });
    await prisma.webhookEvent.deleteMany({ where: { externalMessageId: externalId } });
    await prisma.conversation.deleteMany({ where: { remoteJid } });
  });

  it("ends at read after delivered then read then a late delivered", async () => {
    const store = createIngestStore(createDb(prisma));
    const payload = upsertPayload({ instance: instanceName, id: externalId, remoteJid, fromMe: true });
    const inserted = await persistRawEvent(store, payload);
    await canonicalizeEvent(store, inserted.id);

    const delivered = await persistRawEvent(
      store,
      statusUpdatePayload({ instance: instanceName, id: externalId, remoteJid, status: "DELIVERY_ACK" }),
    );
    await canonicalizeEvent(store, delivered.id);
    const read = await persistRawEvent(
      store,
      statusUpdatePayload({ instance: instanceName, id: externalId, remoteJid, status: "READ" }),
    );
    await canonicalizeEvent(store, read.id);
    const late = await persistRawEvent(
      store,
      statusUpdatePayload({ instance: instanceName, id: externalId, remoteJid, status: "DELIVERY_ACK" }),
    );
    await canonicalizeEvent(store, late.id);

    const row = await prisma.message.findFirst({ where: { externalMessageId: externalId } });
    expect(row?.providerStatus).toBe("read");
    expect(await prisma.message.count({ where: { externalMessageId: externalId } })).toBe(1);
  });
});
