/**
 * Test design — `db.tx` calls that share one transaction do not interleave
 *
 * SUT: `withModuleRole` from `kernel/db.ts`, driven with a fake transaction
 *   client that records every statement and yields to the event loop before
 *   answering, so concurrent callers get every chance to interleave. No
 *   database: what is under test is the ORDER of statements, which a fake pins
 *   exactly. `roles.test.ts` runs the same shapes on the real harness.
 *
 * Why. Under the test harness every `db.tx` joins the test's one transaction.
 *   Found in wave 2 (2C): `Promise.all` over `db.tx` interleaved SAVEPOINT /
 *   SET ROLE / RELEASE across callers, so one call released another's savepoint
 *   and reset the role under it. And a nested call (a contract inside another
 *   module's `db.tx`) ended with `RESET ROLE`, so the caller's later writes ran
 *   unchecked — live in production, not only in tests.
 *
 * Partitions:
 *   P1 concurrent top-level calls, same transaction — one after another, FIFO.
 *   P2 a nested call — runs at once; on exit the caller's role is set again.
 *   P3 concurrent nested calls — one after another inside the caller.
 *   P4 a call that throws — rolled back; the next queued call still runs.
 *   P5 calls on DIFFERENT transactions — still overlap (production parallelism).
 *
 * P5 is the positive control for P1: a version that serialised everything
 *   globally would pass P1 and fail P5. The old implementation fails P1-P3.
 */
import { describe, expect, it } from "vitest";
import type { DbClient } from "@select-lub/core/db";
import { withModuleRole } from "../src/kernel/db.js";

function fakeTx(label: string, log: string[]) {
  const tx = {
    async $executeRawUnsafe(sql: string) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      log.push(label ? `${label}: ${sql}` : sql);
      return 0;
    },
  };
  return tx as unknown as DbClient;
}

const joining = (tx: DbClient) => <T>(fn: (t: DbClient) => Promise<T>) => fn(tx);
const query = (tx: DbClient, name: string) => tx.$executeRawUnsafe(`QUERY ${name}`);

describe("withModuleRole on a shared transaction", () => {
  it("runs concurrent top-level calls one after another, in call order", async () => {
    const log: string[] = [];
    const tx = fakeTx("", log);
    await Promise.all(
      ["a", "b", "c"].map((name) =>
        withModuleRole("reports", (t) => query(t, name), joining(tx)),
      ),
    );
    expect(log).toEqual(
      [1, 2, 3].flatMap((n) => [
        `SAVEPOINT module_role_${n}`,
        "SET LOCAL ROLE module_reports",
        `QUERY ${"abc"[n - 1]}`,
        `RELEASE SAVEPOINT module_role_${n}`,
        "RESET ROLE",
      ]),
    );
  });

  it("gives a nested call its role, then puts the caller's back", async () => {
    const log: string[] = [];
    const tx = fakeTx("", log);
    await withModuleRole(
      "plate-lookup",
      async (t) => {
        await withModuleRole("reports", (inner) => query(inner, "inner"), joining(t));
        await query(t, "outer-after");
      },
      joining(tx),
    );
    expect(log).toEqual([
      "SAVEPOINT module_role_1",
      "SET LOCAL ROLE module_plate_lookup",
      "SAVEPOINT module_role_2",
      "SET LOCAL ROLE module_reports",
      "QUERY inner",
      "RELEASE SAVEPOINT module_role_2",
      "SET LOCAL ROLE module_plate_lookup",
      "QUERY outer-after",
      "RELEASE SAVEPOINT module_role_1",
      "RESET ROLE",
    ]);
  });

  it("runs concurrent nested calls one after another inside their caller", async () => {
    const log: string[] = [];
    const tx = fakeTx("", log);
    await withModuleRole(
      "plate-lookup",
      (t) =>
        Promise.all([
          withModuleRole("reports", (inner) => query(inner, "x"), joining(t)),
          withModuleRole("quotes", (inner) => query(inner, "y"), joining(t)),
        ]),
      joining(tx),
    );
    expect(log).toEqual([
      "SAVEPOINT module_role_1",
      "SET LOCAL ROLE module_plate_lookup",
      "SAVEPOINT module_role_2",
      "SET LOCAL ROLE module_reports",
      "QUERY x",
      "RELEASE SAVEPOINT module_role_2",
      "SET LOCAL ROLE module_plate_lookup",
      "SAVEPOINT module_role_3",
      "SET LOCAL ROLE module_quotes",
      "QUERY y",
      "RELEASE SAVEPOINT module_role_3",
      "SET LOCAL ROLE module_plate_lookup",
      "RELEASE SAVEPOINT module_role_1",
      "RESET ROLE",
    ]);
  });

  it("rolls back a call that throws and still runs the one queued behind it", async () => {
    const log: string[] = [];
    const tx = fakeTx("", log);
    const [failed, passed] = await Promise.allSettled([
      withModuleRole(
        "reports",
        async () => {
          throw new Error("slice failed");
        },
        joining(tx),
      ),
      withModuleRole("reports", (t) => query(t, "next"), joining(tx)),
    ]);
    expect(failed.status).toBe("rejected");
    expect(passed.status).toBe("fulfilled");
    expect(log).toEqual([
      "SAVEPOINT module_role_1",
      "SET LOCAL ROLE module_reports",
      "ROLLBACK TO SAVEPOINT module_role_1",
      "RESET ROLE",
      "SAVEPOINT module_role_2",
      "SET LOCAL ROLE module_reports",
      "QUERY next",
      "RELEASE SAVEPOINT module_role_2",
      "RESET ROLE",
    ]);
  });

  it("does not serialise calls on different transactions", async () => {
    const log: string[] = [];
    const first = fakeTx("A", log);
    const second = fakeTx("B", log);
    await Promise.all([
      withModuleRole("reports", (t) => query(t, "a"), joining(first)),
      withModuleRole("reports", (t) => query(t, "b"), joining(second)),
    ]);
    expect(log.indexOf("B: SAVEPOINT module_role_1")).toBeLessThan(
      log.indexOf("A: RELEASE SAVEPOINT module_role_1"),
    );
  });
});

/**
 * A client that wraps another — a Proxy, a recording client — is a different
 * object for the kernel. Found in wave 3 (3C): a nested call through such a
 * wrapper ended with RESET ROLE, leaving the caller's later writes unchecked.
 * The kernel now asks the database which role is in effect in that one case.
 */
describe("withModuleRole through a wrapped client", () => {
  function answeringTx(log: string[], currentUser: string) {
    const tx = fakeTx("", log) as unknown as Record<string, unknown>;
    tx.$queryRawUnsafe = async (sql: string) => {
      log.push(sql);
      return [{ current_user: currentUser }];
    };
    return tx as unknown as DbClient;
  }

  it("puts the caller's role back after a nested call made through a wrapper of the same transaction", async () => {
    const log: string[] = [];
    const tx = answeringTx(log, "module_plate_lookup");
    await withModuleRole(
      "plate-lookup",
      async (t) => {
        const wrapped = new Proxy(t as object, {}) as DbClient;
        await withModuleRole("reports", (inner) => query(inner, "inner"), joining(wrapped));
        await query(t, "outer-after");
      },
      joining(tx),
    );
    expect(log).toEqual([
      "SAVEPOINT module_role_1",
      "SET LOCAL ROLE module_plate_lookup",
      "SELECT current_user",
      "SAVEPOINT module_role_1",
      "SET LOCAL ROLE module_reports",
      "QUERY inner",
      "RELEASE SAVEPOINT module_role_1",
      "SET LOCAL ROLE module_plate_lookup",
      "QUERY outer-after",
      "RELEASE SAVEPOINT module_role_1",
      "RESET ROLE",
    ]);
  });

  it("resets a genuinely separate transaction opened inside another module's call", async () => {
    const outerLog: string[] = [];
    const innerLog: string[] = [];
    const outer = fakeTx("", outerLog);
    const separate = answeringTx(innerLog, "selectlub");
    await withModuleRole(
      "plate-lookup",
      () => withModuleRole("reports", (inner) => query(inner, "inner"), joining(separate)),
      joining(outer),
    );
    expect(innerLog).toEqual([
      "SELECT current_user",
      "SAVEPOINT module_role_1",
      "SET LOCAL ROLE module_reports",
      "QUERY inner",
      "RELEASE SAVEPOINT module_role_1",
      "RESET ROLE",
    ]);
  });

  it("does not ask the database on the ordinary paths", async () => {
    const log: string[] = [];
    const tx = answeringTx(log, "module_plate_lookup");
    await withModuleRole(
      "plate-lookup",
      (t) => withModuleRole("reports", (inner) => query(inner, "inner"), joining(t)),
      joining(tx),
    );
    expect(log).not.toContain("SELECT current_user");
  });
});
