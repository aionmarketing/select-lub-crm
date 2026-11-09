/**
 * Test design — a module role refuses a foreign write, and gives the role back
 *
 * SUT: `db.tx` from `kernel/db.ts`, on the real database inside the rollback
 *   harness, with `db/grants.generated.sql` already applied by `db:migrate`.
 * This is the load-bearing test of the whole change. Everything else —
 *   `ownership.json`, the generator, the ESLint scopes — is a way of arranging
 *   for this one behaviour: code running as one module cannot write another
 *   module's table, and the database is what says so.
 * Raw SQL rather than a Prisma delegate, deliberately. The requirement is that
 *   the refusal holds "through the ORM or through raw SQL", and raw SQL is the
 *   case a lint rule or an arch test scanning ORM calls could never catch. If
 *   this passes, the Prisma path is covered a fortiori: it runs on the same
 *   connection under the same role.
 * `RESET ROLE` is asserted separately because of D2: under the harness the role
 *   is set on the *test's* transaction, so a missing reset would not fail here
 *   — it would fail later, in some other test's seeding, as a confusing
 *   permission error far from its cause.
 * A positive control (`plate-lookup` writing `plate_lookup`, which it owns) is
 *   in the same file so a refusal cannot be mistaken for a database that
 *   refuses everything — e.g. grants applied with the wrong owner.
 * Out of scope: every module against every table. The mechanism is uniform;
 *   `grants.test.ts` is what checks the manifest covers all eleven.
 */
import { prisma } from "@select-lub/core/db";
import { describeWithDatabase, runInTransactionOnTx, withTestTransaction } from "../src/testing/index.js";
import { createDb } from "../src/kernel/db.js";
import { expect, it } from "vitest";

describeWithDatabase("module roles", () => {
  it("refuses a write to a table the module does not own", () =>
    withTestTransaction(prisma!, async (tx) => {
      const db = createDb(tx, runInTransactionOnTx(tx));

      await expect(
        db.tx("plate-lookup", async (t) => {
          await t.$executeRawUnsafe(
            `INSERT INTO customer (id, unit_id, created_at, updated_at) VALUES ('role-test', 'role-test-unit', now(), now())`,
          );
        }),
      ).rejects.toThrow(/permission denied/i);
    }));

  it("allows a write to a table the module owns", () =>
    withTestTransaction(prisma!, async (tx) => {
      const db = createDb(tx, runInTransactionOnTx(tx));

      // The positive control. If the grants were applied for the wrong login
      // role, or REVOKE ran without the matching GRANT, the refusal above would
      // pass for the wrong reason and this would fail.
      await expect(
        db.tx("plate-lookup", async (t) => {
          const rows = await t.$queryRawUnsafe<{ count: bigint }[]>(
            `SELECT count(*)::bigint AS count FROM plate_lookup`,
          );
          expect(rows).toHaveLength(1);
        }),
      ).resolves.toBeUndefined();
    }));

  it("restores the login role afterwards, so the test can still seed", () =>
    withTestTransaction(prisma!, async (tx) => {
      const db = createDb(tx, runInTransactionOnTx(tx));
      const [{ current_user: before }] =
        await tx.$queryRawUnsafe<{ current_user: string }[]>(`SELECT current_user`);

      await db.tx("plate-lookup", async (t) => {
        const [{ current_user: inside }] =
          await t.$queryRawUnsafe<{ current_user: string }[]>(`SELECT current_user`);
        expect(inside).toBe("module_plate_lookup");
      });

      const [{ current_user: after }] =
        await tx.$queryRawUnsafe<{ current_user: string }[]>(`SELECT current_user`);
      expect(after).toBe(before);
      expect(after).not.toBe("module_plate_lookup");
    }));

  it("restores the login role even when the slice threw", () =>
    withTestTransaction(prisma!, async (tx) => {
      const db = createDb(tx, runInTransactionOnTx(tx));
      const [{ current_user: before }] =
        await tx.$queryRawUnsafe<{ current_user: string }[]>(`SELECT current_user`);

      await expect(
        db.tx("reports", async () => {
          throw new Error("slice failed");
        }),
      ).rejects.toThrow("slice failed");

      const [{ current_user: after }] =
        await tx.$queryRawUnsafe<{ current_user: string }[]>(`SELECT current_user`);
      expect(after).toBe(before);
    }));

  it("runs concurrent db.tx calls on one transaction, each under its own role", () =>
    withTestTransaction(prisma!, async (tx) => {
      const db = createDb(tx, runInTransactionOnTx(tx));
      const whoAmI = (module: "reports" | "quotes" | "plate-lookup") =>
        db.tx(module, async (t) => {
          const [{ current_user: user }] =
            await t.$queryRawUnsafe<{ current_user: string }[]>(`SELECT current_user`);
          return user;
        });

      // Before the per-transaction queue, these interleaved their SAVEPOINT /
      // SET ROLE / RELEASE steps and aborted the transaction (wave 2, 2C).
      const users = await Promise.all([
        whoAmI("reports"),
        whoAmI("quotes"),
        whoAmI("plate-lookup"),
        whoAmI("reports"),
      ]);

      expect(users).toEqual([
        "module_reports",
        "module_quotes",
        "module_plate_lookup",
        "module_reports",
      ]);
    }));

  it("keeps checking the caller's writes after a nested call returns", () =>
    withTestTransaction(prisma!, async (tx) => {
      const db = createDb(tx, runInTransactionOnTx(tx));

      // Before the fix, the nested call's exit ran RESET ROLE, so this INSERT
      // ran as the login role and was not refused for permission.
      await expect(
        db.tx("plate-lookup", async (t) => {
          await db.tx("reports", async () => undefined, runInTransactionOnTx(t));
          const [{ current_user: after }] =
            await t.$queryRawUnsafe<{ current_user: string }[]>(`SELECT current_user`);
          expect(after).toBe("module_plate_lookup");
          await t.$executeRawUnsafe(
            `INSERT INTO customer (id, unit_id, created_at, updated_at) VALUES ('role-test-nested', 'role-test-unit', now(), now())`,
          );
        }),
      ).rejects.toThrow(/permission denied/i);
    }));

  it("keeps checking the caller's writes after a nested call made through a wrapped client", () =>
    withTestTransaction(prisma!, async (tx) => {
      const db = createDb(tx, runInTransactionOnTx(tx));

      // Found in wave 3 (3C): a recorder that wrapped the transaction in a Proxy
      // made the nested call's exit RESET ROLE, so this INSERT ran as the login
      // role, which Postgres allows. The kernel now asks which role is in effect.
      await expect(
        db.tx("plate-lookup", async (t) => {
          const wrapped = new Proxy(t, {}) as typeof t;
          await db.tx("reports", async () => undefined, runInTransactionOnTx(wrapped));
          const [{ current_user: after }] =
            await t.$queryRawUnsafe<{ current_user: string }[]>(`SELECT current_user`);
          expect(after).toBe("module_plate_lookup");
          await t.$executeRawUnsafe(
            `INSERT INTO customer (id, unit_id, created_at, updated_at) VALUES ('role-test-wrapped', 'role-test-unit', now(), now())`,
          );
        }),
      ).rejects.toThrow(/permission denied/i);
    }));
});
