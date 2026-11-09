/**
 * Test design (testing-strategy)
 *
 * SUT: `reclaimStuck`'s SQL, through the slice's entry point, on a kernel handle
 *   over a fake PrismaClient whose role-switch statements are no-ops. No Postgres.
 *
 * Ran under module role: `channel` (requested; the fake has no roles to refuse).
 *
 * Moved from apps/worker/src/outbox/prisma.test.ts (adopt-modular-vertical-slices
 * 3A): its reclaim case, where the query was `reclaimAbandonedClaims`. The other
 * 5 went to drain-outbox/tests/drain-outbox.queries.test.ts; that file keeps the
 * original axes. Postgres's own INTERVAL evaluation is
 * reclaim-stuck.integration.test.ts.
 *
 * Oracle: outbox-claim-recovery whatsapp-channel — reclaim is one bulk UPDATE
 *   parameterized by timeout. A5 reclaim timeoutMs — passed through as the
 *   INTERVAL parameter; fails if the INTERVAL is hardcoded.
 */
import { describe, expect, it } from "vitest";
import { createDb, type Db, type DbClient } from "../../../../kernel/db.js";
import { reclaimStuck } from "../index.js";

function sqlText(strings: TemplateStringsArray) {
  return [...strings].join("?");
}

/** A `Db` over `fake`, whose role-switch statements are no-ops. */
function fakeDb(fake: object): Db {
  const client = { $executeRawUnsafe: async () => 0, ...fake } as unknown as DbClient;
  return createDb(client, (fn) => fn(client));
}

describe("reclaim-stuck SQL", () => {
  it("parameterizes reclaim INTERVAL by timeoutMs", async () => {
    let sql = "";
    let params: unknown[] = [];
    const prisma = {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        sql = sqlText(strings);
        params = values;
        return 1;
      },
    };

    await reclaimStuck(fakeDb(prisma), 180_000);

    expect(sql).toMatch(/status = 'failed'/);
    expect(sql).not.toMatch(/status = 'queued'/);
    expect(sql).toMatch(/claimed_at < NOW\(\)/);
    expect(sql).toMatch(/INTERVAL/i);
    expect(params).toContain(180_000);
    expect(params).toContain("send_outcome_unknown");
  });
});
