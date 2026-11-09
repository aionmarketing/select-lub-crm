/**
 * Test design (testing-strategy)
 *
 * SUT: `recordWebhookEvent` — which transaction options the receipt is opened
 *   with — through the slice's entry point, on a kernel handle over a fake client
 *   that records them (the shape of packages/core/src/kernel/prisma/transaction-options.test.ts).
 *   No database.
 *
 * Ran under module role: `channel` (requested; the fake has no roles to refuse).
 *
 * Oracle: 3A-channel review, item 2. The receipt stores a body of up to the
 *   worker's 50 MiB limit. The old route used an autocommit `create`; inside the
 *   kernel's default 5 s interactive transaction a large `messages.set` dump
 *   could time out and be redelivered. The receipt's one transaction opens with
 *   WEBHOOK_RECEIPT_TRANSACTION_OPTIONS (60 s run limit). Mutation-checked:
 *   dropping the runner opens it with the kernel's 5 s default and fails.
 *
 * Cases: a client that can open a transaction — opened once, with the receipt's
 *   options; the value of those options, pinned.
 */
import { describe, expect, it } from "vitest";
import { createDb, type DbClient } from "../../../../kernel/db.js";
import { recordWebhookEvent, WEBHOOK_RECEIPT_TRANSACTION_OPTIONS } from "../../contracts/webhook-events.js";

describe("recordWebhookEvent transaction options", () => {
  it("opens the receipt with a 60 s run limit, not the kernel's 5 s default", async () => {
    const opened: unknown[] = [];
    const created: unknown[] = [];
    const inner = {
      $executeRawUnsafe: async () => 0,
      whatsAppConnection: { findUnique: async () => ({ id: "conn-1" }) },
      webhookEvent: {
        create: async (args: { data: unknown }) => {
          created.push(args.data);
          return { id: "event-1" };
        },
      },
    } as unknown as DbClient;
    const client = {
      async $transaction(fn: (tx: DbClient) => Promise<unknown>, options: unknown) {
        opened.push(options);
        return fn(inner);
      },
    };

    const event = await recordWebhookEvent(createDb(client as never), {
      event: "MESSAGES_SET",
      instance: "select-lub-test",
      data: { bulky: "x" },
    });

    expect(event).toEqual({ id: "event-1" });
    expect(opened).toEqual([{ maxWait: 10_000, timeout: 60_000 }]);
    expect(created).toHaveLength(1);
  });

  it("pins the receipt's limits", () => {
    expect(WEBHOOK_RECEIPT_TRANSACTION_OPTIONS).toEqual({ maxWait: 10_000, timeout: 60_000 });
  });
});
