/**
 * Test design (testing-strategy)
 *
 * Setup: the drain's queries (`claimQueued`, `markFailedQueued`) through the
 * slice's entry point, on a kernel handle over a fake PrismaClient. No Postgres.
 * The handle's role switch (`SAVEPOINT`, `SET LOCAL ROLE`) goes to a no-op
 * `$executeRawUnsafe`, so each fake answers only the query under test.
 *
 * Ran under module role: `channel` (requested; the fake has no roles to refuse).
 *
 * Moved from apps/worker/src/outbox/prisma.test.ts (adopt-modular-vertical-slices
 * 3A), where the same SQL was `createPrismaOutbox`. 5 of its 6 cases are here;
 * the reclaim case moved with its query to
 * reclaim-stuck/tests/reclaim-stuck.sql.test.ts. Assertions unchanged.
 *
 * Oracle: conversation-phone-unique (claim maps chatKey) +
 *   outbox-claim-recovery whatsapp-channel — markFailedQueued is one
 *   UPDATE RETURNING; reclaim is one bulk UPDATE parameterized by timeout.
 *
 * Axes
 *   A1 claimQueued RETURNING — empty vs one row
 *   A2 conversation.chatKey vs remoteJid spelling
 *   A3 markFailedQueued RETURNING — queued / failed / empty (cancelled)
 *   A4 markFailedQueued writes — one $queryRaw UPDATE vs old find+update+updateMany
 *   A5 reclaim timeoutMs — passed through as the INTERVAL parameter
 *
 * Outputs: O1 null claim; O2 claimed.customerPhoneNormalized === chatKey;
 *   O3 { attemptCount, status: queued|failed }; O4 null fail result;
 *   O5 reclaim SQL uses timeoutMs
 *
 * Sampled-cell
 *   empty claim                 | A1 empty     | O1 | a row
 *   chatKey mapping             | A2 chatKey   | O2 | remoteJid host
 *   RETURNING queued            | A3 queued    | O3 | status claimed
 *   RETURNING failed            | A3 failed    | O3 | status claimed
 *   empty RETURNING cancelled   | A3 empty     | O4 | increment observed
 *   single UPDATE no two-write  | A4 one query | O3 | findUnique/update called
 *   reclaim passes timeoutMs    | A5 300000    | O5 | hardcoded INTERVAL
 *
 * Decision / branch map (outbox/prisma.ts)
 *   claim !rows[0]                 T empty-claim it; F chatKey it
 *   markFailedQueued !rows[0]      T cancelled it; F queued/failed its
 *   reclaimAbandonedClaims         no JS branch — SQL + timeout sampled
 *
 * Out of scope: live SKIP LOCKED (packages/core/test/outbox-claim-race.live.test.ts); Postgres INTERVAL evaluation
 *   (reclaim.test.ts + worker.test.ts on the memory store).
 */
import { describe, expect, it } from "vitest";
import { createDb, type Db, type DbClient } from "../../../../kernel/db.js";
import { claimQueued, markFailedQueued } from "../index.js";

/** A `Db` over `fake`, whose role-switch statements are no-ops. */
function fakeDb(fake: object): Db {
  const client = { $executeRawUnsafe: async () => 0, ...fake } as unknown as DbClient;
  return createDb(client, (fn) => fn(client));
}

function sqlText(strings: TemplateStringsArray) {
  return [...strings].join("?");
}

function forbiddenTwoWrite() {
  return {
    findUnique: async () => {
      throw new Error("old two-write findUnique must not run");
    },
    update: async () => {
      throw new Error("old two-write update must not run");
    },
    updateMany: async () => {
      throw new Error("old two-write updateMany must not run");
    },
  };
}

describe("drain-outbox queries", () => {
  it("returns null when no queued row is claimed", async () => {
    const prisma = {
      $queryRaw: async () => [],
    };

    expect(await claimQueued(fakeDb(prisma))).toBeNull();
  });

  it("maps conversation.chatKey onto customerPhoneNormalized", async () => {
    const prisma = {
      $queryRaw: async () => [
        {
          id: "ob-1",
          conversation_id: "conv-1",
          message_type: "text",
          text_body: "oi",
          media_bytes: null,
          media_mime_type: null,
          media_file_name: null,
        },
      ],
      conversation: {
        findUniqueOrThrow: async () => ({
          remoteJid: "5511999999999@c.us",
          chatKey: "5511999999999",
          whatsappConnectionId: "conn-1",
          whatsappConnection: { instanceName: "select-lub-poc" },
        }),
      },
    };

    const claimed = await claimQueued(fakeDb(prisma));

    expect(claimed).toMatchObject({
      id: "ob-1",
      conversationId: "conv-1",
      remoteJid: "5511999999999@c.us",
      customerPhoneNormalized: "5511999999999",
      whatsappConnectionId: "conn-1",
      instanceName: "select-lub-poc",
    });
  });

  it("returns one queued row from a single markFailedQueued UPDATE", async () => {
    let queryCount = 0;
    let sql = "";
    const prisma = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        queryCount += 1;
        sql = sqlText(strings);
        return [{ attempt_count: 3, status: "queued" }];
      },
      outboxMessage: forbiddenTwoWrite(),
    };

    const result = await markFailedQueued(fakeDb(prisma), "ob-1", "evolution 502");

    expect(queryCount).toBe(1);
    expect(sql).toMatch(/UPDATE outbox_message/i);
    expect(sql).toMatch(/RETURNING attempt_count, status/);
    expect(sql).toMatch(/media_bytes IS NOT NULL/);
    expect(sql).toMatch(/status = 'claimed'/);
    expect(result).toEqual({ attemptCount: 3, status: "queued" });
    expect(["queued", "failed"]).toContain(result?.status);
  });

  it("returns one failed row from a single markFailedQueued UPDATE", async () => {
    const prisma = {
      $queryRaw: async () => [{ attempt_count: 5, status: "failed" }],
      outboxMessage: forbiddenTwoWrite(),
    };

    const result = await markFailedQueued(fakeDb(prisma), "ob-1", "evolution 502");

    expect(result).toEqual({ attemptCount: 5, status: "failed" });
    expect(["queued", "failed"]).toContain(result?.status);
  });

  it("returns null when markFailedQueued RETURNING is empty", async () => {
    const prisma = {
      $queryRaw: async () => [],
      outboxMessage: forbiddenTwoWrite(),
    };

    expect(await markFailedQueued(fakeDb(prisma), "ob-1", "nope")).toBeNull();
  });
});
