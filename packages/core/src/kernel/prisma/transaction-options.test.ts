/**
 * Test design — how `runInTransactionFor` opens a production transaction
 *
 * SUT: `runInTransactionFor` from `transaction.ts`, with fake clients. No
 *   database: what is under test is the options handed to `$transaction`, which
 *   a fake records exactly.
 *
 * Why. Wave 2 moved plain queries into `db.tx` transactions. Prisma's default
 *   `maxWait` is 2 s, while a plain query waits 10 s for a pooled connection, so
 *   on a small pool a request that used to queue now failed to start. The
 *   options pin the 10 s wait and the 5 s run limit a slice is written against.
 *
 * Partitions:
 *   P1 a client that can open transactions — `$transaction` gets the options.
 *   P2 an already-open transaction client — `fn` runs on it; nothing is opened.
 *
 * P2 is the control for P1: it shows the options are applied only where a
 *   transaction is actually opened, not smuggled into the harness path.
 */
import { describe, expect, it } from "vitest";
import type { DbClient } from "./transaction.js";
import { runInTransactionFor, TRANSACTION_OPTIONS } from "./transaction.js";

describe("runInTransactionFor", () => {
  it("opens a production transaction with a 10 s connection wait and a 5 s run limit", async () => {
    const calls: unknown[] = [];
    const inner = { marker: "tx" } as unknown as DbClient;
    const client = {
      async $transaction(fn: (tx: DbClient) => Promise<unknown>, options: unknown) {
        calls.push(options);
        return fn(inner);
      },
    };

    const result = await runInTransactionFor(client as never)(async (tx) => tx);

    expect(result).toBe(inner);
    expect(calls).toEqual([{ maxWait: 10_000, timeout: 5_000 }]);
    expect(TRANSACTION_OPTIONS).toEqual({ maxWait: 10_000, timeout: 5_000 });
  });

  it("runs on an already-open transaction without opening another", async () => {
    const open = { marker: "open" } as unknown as DbClient;

    const result = await runInTransactionFor(open)(async (tx) => tx);

    expect(result).toBe(open);
  });
});
