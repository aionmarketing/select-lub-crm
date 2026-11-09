/**
 * Test design (testing-strategy) — conversations writes only its own six tables
 *
 * Requirement (4A, closing W3-C4, W3-C5 and W3-C6): the ingest subscribers and
 * every conversations route write under `db.tx("conversations", …)`. Before 4A
 * three subscribers ran on the login role: the drain's sent-message insert
 * (W3-C4), the history backfill's insert (W3-C5), and the webhook's
 * canonicalization, which also wrote `webhook_event`'s lifecycle directly rather
 * than through channel (W3-C6).
 *
 * How it is shown, in three parts (the shape of `services-roles.test.ts`, plus
 * erp's recorder):
 *   1. THE DATABASE REFUSES THE REST. Under `module_conversations` a write to
 *      `webhook_event`, `outbox_message`, `whatsapp_connection` (channel's) or
 *      `customer` (customers') is refused by Postgres; writes to the six owned
 *      tables are accepted — the positive control, so the refusals are not a
 *      role that can write nothing. Each refusal sits last in its own test.
 *   2. THE SUBSCRIBERS RUN UNDER THEIR OWNERS' ROLES. The three ingest
 *      subscribers are driven through the events that reach them in production
 *      — `channel/webhook-received` (a message, then a `connection.update`),
 *      `channel/outbound-sent`, `channel/history-record-fetched` — on a `Db`
 *      whose client records every write — delegate calls, and the raw
 *      `INSERT … ON CONFLICT` / `UPDATE` the ingest store upserts with — with the
 *      role Postgres reports for it (`current_user`, mapped back to its module;
 *      `unscoped` for the login role). A control first shows the recorder does
 *      see an unscoped write. Every `conversation`/`message` write is `conversations`,
 *      every `webhook_event`/`whatsapp_connection` write is `channel` (through
 *      its contracts), and none is unscoped. It asks Postgres rather than
 *      trusting the handle's label, as erp's `run-pull.roles` does.
 *   3. NOTHING RUNS OUTSIDE A MODULE ROLE. The module's source never touches
 *      `.client`, every Prisma delegate write names an owned delegate, and every
 *      raw `UPDATE`/`INSERT INTO`/`DELETE FROM` names an owned table.
 *
 * Setup: one loja, one connection, inside one rolling-back transaction per test.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { prisma, type DbClient, type PrismaClient } from "@select-lub/core/db";
import { describe, expect, it } from "vitest";
import { createDb, MODULE_NAMES, roleFor, type ModuleName } from "../src/kernel/db.js";
import { publish } from "../src/kernel/events.js";
import { historyRecordFetched, outboundSent, webhookReceived } from "../src/modules/channel/contracts/index.js";
import {
  canonicalizeReceivedWebhooks,
  createIngestStore,
  ingestFetchedHistory,
  insertSentMessages,
  persistRawEvent,
} from "../src/modules/conversations/index.js";
import {
  connectionUpdatePayload,
  describeWithDatabase,
  historyRow,
  runInTransactionOnTx,
  seedConnection,
  seedConversation,
  seedUnit,
  seedUser,
  upsertPayload,
  withTestTransaction,
} from "../src/testing/index.js";

const db = () => prisma as PrismaClient;
const MODULE_DIR = resolve(import.meta.dirname, "../src/modules/conversations");

/** The six tables `ownership.json` gives conversations, as Prisma delegates and as tables. */
const OWNED_DELEGATES = new Set(["conversation", "message", "tag", "template", "conversationTag", "followUpClosedEntry"]);
const OWNED_TABLES = new Set(["conversation", "message", "tag", "template", "conversation_tag", "follow_up_closed_entry"]);

/** A loja, its connection, a conversation, a user, and a customer to aim at. */
async function seedTargets(tx: DbClient) {
  const unit = await seedUnit(tx);
  const user = await seedUser(tx, { units: [unit.id] });
  const connection = await seedConnection(tx, { unitId: unit.id });
  const conversation = await seedConversation(tx, { connectionId: connection.id });
  const customer = await tx.customer.create({ data: { origin: "crm", status: "active", unitId: unit.id }, select: { id: true } });
  return { unit, user, connection, conversation, customerId: customer.id };
}

function asConversations<T>(tx: DbClient, fn: (inner: DbClient) => Promise<T>) {
  return createDb(tx, runInTransactionOnTx(tx)).tx("conversations", fn);
}

describeWithDatabase("module_conversations at the database", () => {
  it("may write conversation, message, tag, template, conversation_tag and follow_up_closed_entry", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedTargets(tx);

      await asConversations(tx, async (inner) => {
        await inner.conversation.update({ where: { id: t.conversation.id }, data: { lastMessageAt: new Date() } });
        await inner.message.create({
          data: {
            conversationId: t.conversation.id,
            externalMessageId: "ROLE-OWN-1",
            direction: "inbound",
            messageType: "text",
            providerTimestamp: new Date("2099-01-01T12:00:00.000Z"),
          },
        });
        const tag = await inner.tag.create({ data: { unitId: t.unit.id, name: "Role" }, select: { id: true } });
        await inner.conversationTag.create({ data: { conversationId: t.conversation.id, tagId: tag.id } });
        await inner.template.create({ data: { unitId: t.unit.id, name: "Role", text: "Oi", allowedVariables: [], status: "active" } });
        await inner.followUpClosedEntry.create({
          data: {
            section: "waitingReply",
            unitId: t.unit.id,
            conversationId: t.conversation.id,
            anchor: "role",
            closedByUserId: t.user.id,
          },
        });
      });

      expect(await tx.conversationTag.count({ where: { conversationId: t.conversation.id } })).toBe(1);
      expect(await tx.followUpClosedEntry.count({ where: { conversationId: t.conversation.id } })).toBe(1);
    }));

  it("is refused a write to webhook_event, channel's table", () =>
    withTestTransaction(db(), async (tx) => {
      await seedTargets(tx);
      await expect(
        asConversations(tx, (inner) => inner.webhookEvent.create({ data: { payload: {}, status: "received" } })),
      ).rejects.toThrow(/permission denied/i);
    }));

  it("is refused a write to outbox_message, channel's table", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedTargets(tx);
      await expect(
        asConversations(tx, (inner) =>
          inner.outboxMessage.create({ data: { conversationId: t.conversation.id, textBody: "x", status: "queued" } }),
        ),
      ).rejects.toThrow(/permission denied/i);
    }));

  it("is refused a write to whatsapp_connection, channel's table", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedTargets(tx);
      await expect(
        asConversations(tx, (inner) =>
          inner.whatsAppConnection.update({ where: { id: t.connection.id }, data: { connectionState: "DISCONNECTED" } }),
        ),
      ).rejects.toThrow(/permission denied/i);
    }));

  it("is refused a write to customer, customers' table", () =>
    withTestTransaction(db(), async (tx) => {
      const t = await seedTargets(tx);
      await expect(
        asConversations(tx, (inner) => inner.customer.update({ where: { id: t.customerId }, data: { name: "x" } })),
      ).rejects.toThrow(/permission denied/i);
    }));
});

/** Every Prisma delegate method that writes. */
const WRITE_METHODS = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany"]);

type Write = { module: ModuleName | "unscoped"; model: string };

/** The module whose role Postgres reports, or `unscoped` for the login role. */
async function moduleNow(client: DbClient): Promise<Write["module"]> {
  const [row] = await client.$queryRawUnsafe<{ role: string }[]>("SELECT current_user AS role");
  return MODULE_NAMES.find((name) => roleFor(name) === row?.role) ?? "unscoped";
}

/**
 * A raw SQL write's target table, or null for anything else. `DO UPDATE` (an
 * upsert's conflict arm) is part of an `INSERT` already counted.
 */
const RAW_WRITE = /\b(?<!DO\s)(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"?(\w+)"?/;
const RAW_METHODS = new Set(["$executeRaw", "$executeRawUnsafe", "$queryRaw", "$queryRawUnsafe"]);

function rawTable(args: unknown[]): string | null {
  const first = args[0];
  const text = typeof first === "string" ? first : Array.isArray(first) ? first.join(" ") : "";
  return RAW_WRITE.exec(text)?.[1] ?? null;
}

/**
 * A client that logs each write — a delegate write, or a raw `INSERT`/`UPDATE`/
 * `DELETE`, which the ingest store uses for its upserts — with the module whose
 * role it ran under. Wrapped ONCE and the handle built over that one wrapper: the
 * kernel remembers the caller's role by the transaction client's identity (erp's
 * note).
 */
function recording(client: DbClient, log: Write[]): DbClient {
  return new Proxy(client, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value === "function" && typeof prop === "string" && RAW_METHODS.has(prop)) {
        return async (...args: unknown[]) => {
          const table = rawTable(args);
          if (table) {
            log.push({ module: await moduleNow(target), model: table });
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (typeof value === "function") return value.bind(target);
      if (typeof prop !== "string" || prop.startsWith("$") || value === null || typeof value !== "object") {
        return value;
      }
      return new Proxy(value, {
        get(delegate, method) {
          const fn: unknown = Reflect.get(delegate, method);
          if (typeof fn !== "function") return fn;
          if (typeof method === "string" && WRITE_METHODS.has(method)) {
            return async (...args: unknown[]) => {
              log.push({ module: await moduleNow(target), model: prop });
              return fn.apply(delegate, args);
            };
          }
          return fn.bind(delegate);
        },
      });
    },
  });
}

/** The module each written model belongs to, per ownership.json. */
const OWNER: Record<string, Write["module"]> = {
  conversation: "conversations",
  message: "conversations",
  webhookEvent: "channel",
  whatsAppConnection: "channel",
};

describeWithDatabase("the ingest subscribers' writes", () => {
  it("run conversation and message writes under conversations, and channel's under channel", () =>
    withTestTransaction(db(), async (tx) => {
      const unit = await seedUnit(tx);
      const connection = await seedConnection(tx, { unitId: unit.id });
      const writes: Write[] = [];
      const recorded = recording(tx, writes);
      const store = createIngestStore(createDb(recorded, runInTransactionOnTx(recorded)));
      // Control: the recorder can see an unscoped write — a raw one on the bare
      // transaction, outside every `db.tx` — so "none unscoped" below is not a
      // recorder that labels everything with a module.
      await recorded.$executeRaw`UPDATE conversation SET updated_at = updated_at WHERE id = 'role-none'`;
      expect(writes.splice(0)).toEqual([{ module: "unscoped", model: "conversation" }]);
      const offs = [
        canonicalizeReceivedWebhooks(store, () => undefined),
        insertSentMessages(store),
        ingestFetchedHistory(store),
      ];
      try {
        // A live inbound message, then a connection.update, the way receive-webhook
        // hands them over: the receipt row, then the event.
        for (const payload of [
          upsertPayload({ instance: connection.instanceName, id: "ROLE-IN-1", remoteJid: "5511977776666@s.whatsapp.net" }),
          connectionUpdatePayload({ instance: connection.instanceName, state: "close" }),
        ]) {
          const event = await persistRawEvent(store, payload);
          await publish(webhookReceived, { eventId: event.id });
        }
        // The drain's confirmed send.
        await publish(outboundSent, {
          whatsappConnectionId: connection.id,
          remoteJid: "5511977776666@s.whatsapp.net",
          chatKey: "5511977776666",
          externalMessageId: "ROLE-OUT-1",
          direction: "outbound",
          messageType: "text",
          textBody: "resposta",
          providerTimestamp: new Date("2099-01-01T12:01:00.000Z"),
        });
        // One history record.
        await publish(historyRecordFetched, {
          connectionId: connection.id,
          record: historyRow({ id: "ROLE-HIST-1", remoteJid: "5511966665555@s.whatsapp.net" }),
        });
      } finally {
        for (const off of offs) off();
      }

      // Positive control: the three messages really landed, and each table was
      // written, so the ownership check below cannot pass on no writes.
      expect(
        await tx.message.count({
          where: { externalMessageId: { in: ["ROLE-IN-1", "ROLE-OUT-1", "ROLE-HIST-1"] } },
        }),
      ).toBe(3);
      expect(
        (await tx.whatsAppConnection.findUniqueOrThrow({ where: { id: connection.id }, select: { connectionState: true } }))
          .connectionState,
      ).toBe("DISCONNECTED");
      expect(new Set(writes.map((w) => w.model))).toEqual(new Set(Object.keys(OWNER)));

      expect(writes.filter((w) => w.module === "unscoped")).toEqual([]);
      expect(writes.filter((w) => w.module !== OWNER[w.model])).toEqual([]);
    }));
});

/** Every non-test `.ts` file under the module. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "tests" ? [] : sourceFiles(path);
    }
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("conversations' source", () => {
  const files = sourceFiles(MODULE_DIR);
  const WRITE = /\.(\w+)\.(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\(/g;
  const RAW_WRITES = new RegExp(RAW_WRITE.source, "g");

  it("scans a real module: the files exist and they do write", () => {
    // Positive control: a scan of nothing, or a pattern that matches nothing,
    // would pass the checks below vacuously.
    expect(files.length).toBeGreaterThan(30);
    const writes = files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(WRITE)]);
    expect(writes.length).toBeGreaterThan(10);
    const raw = files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(RAW_WRITES)]);
    expect(raw.length).toBeGreaterThan(0);
  });

  it("writes only through the six owned delegates", () => {
    const foreign = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(WRITE)]
        .filter((match) => !OWNED_DELEGATES.has(match[1] as string))
        .map((match) => `${file}: ${match[0]}`),
    );
    expect(foreign).toEqual([]);
  });

  it("writes raw SQL only to owned tables", () => {
    const foreign = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(RAW_WRITES)]
        .filter((match) => !OWNED_TABLES.has(match[1] as string))
        .map((match) => `${file}: ${match[0]}`),
    );
    expect(foreign).toEqual([]);
  });

  it("never reaches the raw client, which carries no module role", () => {
    const raw = files.filter((file) => /\bdb\.client\b|\.client\s*as\b/.test(readFileSync(file, "utf8")));
    expect(raw).toEqual([]);
  });
});
