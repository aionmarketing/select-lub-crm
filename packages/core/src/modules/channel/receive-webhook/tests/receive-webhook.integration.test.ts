/**
 * Test design (testing-strategy)
 *
 * SUT: `POST /webhooks/evolution` — the receipt — through the slice's `route`,
 *   mounted on a slice app over the worktree database inside a rolling-back
 *   transaction, and `summarizeWebhook`, pure. Bearer secret
 *   "test-webhook-secret". The `channel/webhook-received` events are captured;
 *   no subscriber is attached, so nothing canonicalizes.
 *
 * Ran under module role: `channel` (the connection lookup and the
 *   `webhook_event` insert run on `db.tx("channel")`).
 *
 * Moved from apps/worker/src/webhook.test.ts (adopt-modular-vertical-slices 3A,
 * ruling Q6). That file had 18 cases. The 9 here pin the receipt — auth, the
 * 503 arms, the stored row, the log line — and the pure summary. The other 9
 * pin either the worker's app (the 50 MiB body limit, `/health`) or what
 * canonicalization makes of the stored row, and stayed with the worker's app in
 * apps/worker/test/app.test.ts.
 *
 * WHAT CHANGED. The old P1 case waited on canonicalization (`markEvent`) before
 * asserting, because the old route canonicalized after its 200. This route
 * publishes instead, after its 200, so P1 now waits for the published event and
 * asserts it names the stored row — that the receipt hands over exactly what it
 * wrote. The 503 "store unset" arm is now "no database handle bound".
 *
 * Partitions (from the original file):
 *   P1 VALID   — Bearer + db + MESSAGES_UPSERT → 200, 1 event, no file named with
 *                ABC123, logs omit body text and the secret; one event published
 *   P2 INVALID — missing Authorization → 401, 0 events
 *   P3 INVALID — Bearer wrong → 401, 0 events
 *   P5 INVALID — secret unset → 503, 0 events
 *   P6 INVALID — database unset → 503
 *
 * summarizeWebhook: non-object body vs object; missing/non-string event,
 * instance, and key.id (defaults unknown / none). Missing key.id (absent, not
 * merely non-string) is its own `it`.
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { prisma, type PrismaClient } from "@select-lub/core/db";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type DbClient } from "../../../../kernel/db.js";
import { subscribe } from "../../../../kernel/events.js";
import { buildApp, registerSlice } from "../../../../kernel/http.js";
import { webhookReceived } from "../../contracts/webhook-received.js";
import {
  buildSliceApp,
  describeWithDatabase,
  runInTransactionOnTx,
  seedConnection,
  seedUnit,
  withTestTransaction,
} from "../../../../testing/index.js";
import { route, summarizeWebhook } from "../index.js";

const secret = "test-webhook-secret";
const sinkDir = resolve(import.meta.dirname, "../../../../../../../artifacts/evolution-webhooks");

const db = () => prisma as PrismaClient;

/** A MESSAGES_UPSERT envelope, trimmed to what the receipt reads. */
function upsertPayload(instance = "select-lub-test") {
  return {
    event: "MESSAGES_UPSERT",
    instance,
    data: {
      key: { id: "ABC123", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false },
      message: { conversation: "oi" },
      messageTimestamp: 1767268800,
    },
  };
}

type InjectableApp = {
  inject: (opts: object) => Promise<{ statusCode: number; body: string }>;
  close: () => Promise<void>;
};

describeWithDatabase("POST /webhooks/evolution — receipt", () => {
  const apps: InjectableApp[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function setup(tx: DbClient, options?: { secret?: string | undefined; noDb?: true }) {
    const logs: string[] = [];
    const unit = await seedUnit(tx);
    const connection = await seedConnection(tx, { unitId: unit.id });
    const slice = route({
      secret: options && "secret" in options ? options.secret : secret,
      log: (message) => logs.push(message),
    });
    const app = options?.noDb
      ? await buildApp({ mediaMaxBytes: 1024, corsOrigins: [], quiet: true })
      : await buildSliceApp({
          db: createDb(tx, runInTransactionOnTx(tx)),
          plugin: (built) => registerSlice(built, "channel", "receive-webhook", slice),
        });
    if (options?.noDb) {
      registerSlice(app, "channel", "receive-webhook", slice);
    }
    apps.push(app as unknown as InjectableApp);
    return { app: app as unknown as InjectableApp, logs, connection };
  }

  function post(app: InjectableApp, payload: unknown, headers?: Record<string, string>) {
    return app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      headers: { authorization: `Bearer ${secret}`, ...headers },
      payload,
    });
  }

  function eventCount(tx: DbClient, connectionId: string) {
    return tx.webhookEvent.count({ where: { whatsappConnectionId: connectionId } });
  }

  it("accepts a valid Bearer secret and persists a webhook event without a file sink", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, logs, connection } = await setup(tx);
      let published!: (eventId: string) => void;
      const received = new Promise<string>((resolve) => {
        published = resolve;
      });
      const off = subscribe(webhookReceived, ({ eventId }) => published(eventId));

      try {
        const response = await post(app, upsertPayload(connection.instanceName));
        const eventId = await received;

        expect(response.statusCode).toBe(200);
        expect(await eventCount(tx, connection.id)).toBe(1);
        const row = await tx.webhookEvent.findUniqueOrThrow({ where: { id: eventId } });
        expect(row.whatsappConnectionId).toBe(connection.id);
        expect(row.externalMessageId).toBe("ABC123");
        expect(row.status).toBe("received");
      } finally {
        off();
      }
      const sinkFiles = existsSync(sinkDir) ? readdirSync(sinkDir) : [];
      expect(sinkFiles.every((name) => !name.includes("ABC123"))).toBe(true);
      expect(logs.join("\n")).toContain("event=MESSAGES_UPSERT");
      expect(logs.join("\n")).toContain("externalMessageId=ABC123");
      // Neither the message body nor the secret reaches the log.
      expect(logs.join("\n")).not.toContain("oi");
      expect(logs.join("\n")).not.toContain(secret);
    }));

  it("rejects a missing Authorization header", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, connection } = await setup(tx);

      const response = await app.inject({
        method: "POST",
        url: "/webhooks/evolution",
        payload: upsertPayload(connection.instanceName),
      });

      expect(response.statusCode).toBe(401);
      expect(await eventCount(tx, connection.id)).toBe(0);
    }));

  it("rejects a wrong Bearer token", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, connection } = await setup(tx);

      const response = await post(app, upsertPayload(connection.instanceName), {
        authorization: "Bearer wrong",
      });

      expect(response.statusCode).toBe(401);
      expect(await eventCount(tx, connection.id)).toBe(0);
    }));

  it("returns 503 when the webhook secret is unset", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, connection } = await setup(tx, { secret: undefined });

      const response = await post(app, upsertPayload(connection.instanceName));

      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body)).toEqual({ error: "webhook_secret_unset" });
      expect(await eventCount(tx, connection.id)).toBe(0);
    }));

  it("returns 503 when no database handle is bound", () =>
    withTestTransaction(db(), async (tx) => {
      const { app, connection } = await setup(tx, { noDb: true });

      const response = await post(app, upsertPayload(connection.instanceName));

      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body)).toEqual({ error: "database_unset" });
    }));
});

describe("summarizeWebhook", () => {
  it("defaults when the body is not an object", () => {
    expect(summarizeWebhook(null)).toEqual({ event: "unknown", instance: "unknown", externalMessageId: "none" });
    expect(summarizeWebhook("MESSAGES_UPSERT")).toEqual({
      event: "unknown",
      instance: "unknown",
      externalMessageId: "none",
    });
  });

  it("reads string event, instance, and key id", () => {
    expect(summarizeWebhook(upsertPayload())).toEqual({
      event: "MESSAGES_UPSERT",
      instance: "select-lub-test",
      externalMessageId: "ABC123",
    });
  });

  it("defaults non-string event, instance, and id", () => {
    expect(summarizeWebhook({ event: 1, instance: 2, data: { key: { id: 3 } } })).toEqual({
      event: "unknown",
      instance: "unknown",
      externalMessageId: "none",
    });
  });

  it("defaults when key.id is absent", () => {
    expect(summarizeWebhook({ event: "MESSAGES_UPSERT", instance: "select-lub-test", data: { key: {} } })).toEqual({
      event: "MESSAGES_UPSERT",
      instance: "select-lub-test",
      externalMessageId: "none",
    });
  });
});
