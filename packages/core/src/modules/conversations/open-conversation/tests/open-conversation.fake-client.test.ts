/**
 * Test design (testing-strategy) — conversations / open-conversation, store level
 *
 * Moved from `apps/api/src/conversations/prisma.test.ts` (4A), assertions
 * unchanged: its five `create()` cases and the three "a unit's channel means one
 * thing" cases. `store.create(unitId, phone)` is now
 * `openConversation(db, { unitId, instanceName, phone })`; the fake client is the
 * same, handed to each `db.tx` callback by a fake `Db`, so no Postgres and no
 * role. The route's status codes over a real database are this slice's
 * integration test; the role is `packages/core/test/conversations-roles.test.ts`.
 *
 * Setup: `openConversation` over a fake PrismaClient.
 *
 * Oracle: conversas-inbox-completeness design.md D1/D3 — POST /conversations
 * requires that column to read CONNECTED before it creates or reopens a
 * row. Nova conversa reopen by `chat_key` (including an existing `@c.us`
 * thread) is conversation-phone-unique/specs/conversas.
 *
 * Axes
 *   A2 the configured whatsAppConnection row — CONNECTED / other state / absent
 *   A3 conversation row already exists at the unique key — yes / no / appears
 *      between the read and the insert (new with the move)
 *
 * Outputs: O3 channel_down, no conversation.create call; O4 created; O5
 *   existing (no create call)
 *
 * Sampled-cell
 *   not connected            | A2 other     | O3 | create() called
 *   connected, new phone     | A2 T, A3 no  | O4 | no create() call
 *   connected, known phone   | A2 T, A3 yes | O5 | create() called
 *   lost the unique index    | A2 T, A3 appears | O5 | a thrown P2002 (a 500)
 *
 * Decision map (open-conversation/queries.ts)
 *   D2 !connection || unitId differs || connectionState !== "CONNECTED"
 *   D3 existing conversation found — reuse vs create()
 *   D4 findUnique uses whatsappConnectionId_chatKey (typed digits), not remoteJid
 *   D8 create() P2002 — re-read and answer existing (new with the move: the
 *      webhook ingest opening the same thread as the attendant clicks)
 *
 * Unsampled: create() empty digits after conversationChatKeyFromJid
 *   (letters-only phone); a P2002 whose re-read finds nothing (rethrown).
 */
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@select-lub/core/db";
import { describe, expect, it } from "vitest";
import type { Db } from "../../../../kernel/db.js";
import { openConversation } from "../index.js";

type Existing = { id: string; chatKey: string; lastMessageAt: Date; sourceType: string };

function fakeClient(options: {
  /** The row `findUnique({ where: { instanceName } })` returns: the CONFIGURED connection. */
  configuredConnection?: { id: string; unitId: string; connectionState: string } | null;
  connectionByUnit?: { id: string; connectionState: string } | null;
  /** One answer per `conversation.findUnique` call, in order; the last repeats. */
  existingConversations?: (Existing | null)[];
  createThrows?: unknown;
  onCreate?: () => void;
  onFindUnique?: (where: unknown) => void;
  onFindFirst?: () => void;
}): PrismaClient {
  let reads = 0;
  const answers = options.existingConversations ?? [null];
  return {
    whatsAppConnection: {
      findUnique: async () => options.configuredConnection ?? null,
      findFirst: async () => {
        options.onFindFirst?.();
        return options.connectionByUnit ?? null;
      },
    },
    conversation: {
      findUnique: async ({ where }: { where: unknown }) => {
        options.onFindUnique?.(where);
        const answer = answers[Math.min(reads, answers.length - 1)];
        reads += 1;
        return answer ? { ...answer, messages: [] } : null;
      },
      create: async ({ data }: { data: { whatsappConnectionId: string } }) => {
        options.onCreate?.();
        if (options.createThrows) {
          throw options.createThrows;
        }
        return {
          id: "new-conv",
          chatKey: "11999990000",
          lastMessageAt: new Date("2026-08-28T12:00:00.000Z"),
          sourceType: "UNKNOWN",
          whatsappConnectionId: data.whatsappConnectionId,
        };
      },
    },
  } as unknown as PrismaClient;
}

/** A `Db` whose every transaction runs on the fake client. */
function fakeDb(client: PrismaClient): Db {
  return { tx: (_module: string, fn: (tx: PrismaClient) => unknown) => fn(client) } as unknown as Db;
}

const open = (client: PrismaClient, phone: string) =>
  openConversation(fakeDb(client), { unitId: "unit-1", instanceName: "configured", phone });

describe("openConversation", () => {
  it("create() returns channel_down and does not write when not CONNECTED", async () => {
    let created = false;
    const client = fakeClient({
      // The CONFIGURED connection, not merely some connection in the unit. Left as
      // `connectionByUnit` this now passes because the configured row is ABSENT -- it
      // would assert "no row" while claiming to assert "not CONNECTED".
      configuredConnection: { id: "conn-1", unitId: "unit-1", connectionState: "CONNECTING" },
      onCreate: () => {
        created = true;
      },
    });

    const result = await open(client, "11999990000");
    expect(result).toEqual({ status: "channel_down" });
    expect(created).toBe(false);
  });

  it("create() returns channel_down when the unit has no connection row", async () => {
    expect(await open(fakeClient({ configuredConnection: null }), "11999990000")).toEqual({
      status: "channel_down",
    });
  });

  it("create() inserts a new row when CONNECTED and none exists yet", async () => {
    let created = false;
    const client = fakeClient({
      configuredConnection: { id: "conn-1", unitId: "unit-1", connectionState: "CONNECTED" },
      existingConversations: [null],
      onCreate: () => {
        created = true;
      },
    });

    const result = await open(client, "11999990000");
    expect(result.status).toBe("created");
    expect(created).toBe(true);
  });

  it("create() reopens without writing when a row already exists for that phone", async () => {
    let created = false;
    const client = fakeClient({
      configuredConnection: { id: "conn-1", unitId: "unit-1", connectionState: "CONNECTED" },
      existingConversations: [
        {
          id: "conv-existing",
          chatKey: "11999990000",
          lastMessageAt: new Date("2026-08-28T12:00:00.000Z"),
          sourceType: "UNKNOWN",
        },
      ],
      onCreate: () => {
        created = true;
      },
    });

    const result = await open(client, "11999990000");
    expect(result).toEqual({
      status: "existing",
      conversation: {
        id: "conv-existing",
        contactLabel: "11999990000",
        phone: "11999990000",
        lastSnippet: "",
        lastMessageAt: "2026-08-28T12:00:00.000Z",
        tags: [],
        sourceType: "UNKNOWN",
        unanswered: false,
        // A reopened thread with no outbound message is at the first stage,
        // which is what the spec says for inbound-only.
        pipelineStage: "novosContatos",
      },
    });
    expect(created).toBe(false);
  });

  it("create() looks up by chat key so an @c.us thread is reopened", async () => {
    let created = false;
    let findWhere: unknown;
    const client = fakeClient({
      configuredConnection: { id: "conn-1", unitId: "unit-1", connectionState: "CONNECTED" },
      existingConversations: [
        {
          id: "conv-cus",
          chatKey: "5511999999999",
          lastMessageAt: new Date("2026-08-28T12:00:00.000Z"),
          sourceType: "UNKNOWN",
        },
      ],
      onCreate: () => {
        created = true;
      },
      onFindUnique: (where) => {
        findWhere = where;
      },
    });

    const result = await open(client, "5511999999999");
    expect(result.status).toBe("existing");
    if (result.status === "existing") {
      expect(result.conversation.id).toBe("conv-cus");
    }
    expect(created).toBe(false);
    expect(findWhere).toEqual({
      whatsappConnectionId_chatKey: { whatsappConnectionId: "conn-1", chatKey: "5511999999999" },
    });
  });

  it("answers existing when the insert loses the unique index to a concurrent writer", async () => {
    // New with the move (D8). The read found nothing, then the webhook ingest
    // opened the same thread before the insert ran: the insert fails on
    // (whatsapp_connection_id, chat_key), and the thread it lost to is the answer.
    const conflict = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
    let created = false;
    const client = fakeClient({
      configuredConnection: { id: "conn-1", unitId: "unit-1", connectionState: "CONNECTED" },
      existingConversations: [
        null,
        {
          id: "conv-raced",
          chatKey: "11999990000",
          lastMessageAt: new Date("2026-08-28T12:00:00.000Z"),
          sourceType: "UNKNOWN",
        },
      ],
      createThrows: conflict,
      onCreate: () => {
        created = true;
      },
    });

    const result = await open(client, "11999990000");
    // The insert was attempted, so the read-first path did not short-circuit it.
    expect(created).toBe(true);
    expect(result.status).toBe("existing");
    if (result.status === "existing") {
      expect(result.conversation.id).toBe("conv-raced");
    }
  });
});

/**
 * Added for the split-connection defect.
 *
 * SUT: which WhatsApp connection `openConversation` resolves.
 *
 * Oracle: a unit's channel means ONE thing. `channelStatus` and the reports store
 * resolve `findUnique({ where: { instanceName } })` — the configured instance.
 * `create()` once resolved `findFirst({ where: { unitId } })`, unordered, and the
 * unitId it was handed had itself been derived FROM the configured instance.
 *
 * Axes
 *   C1 configured connection state — CONNECTED / not
 *   C2 another connection in the same unit — CONNECTED / DISCONNECTED / absent
 *   C3 the configured connection's unit — the caller's / a different one
 *
 * Sampled cells (one row per `it`)
 *   configured down, other up  | C1,C2 | channel_down; THE case.
 *   configured up, other down  | C1,C2 | creates — the other connection gets no veto
 *   configured in another unit | C3    | channel_down; resolving by instance must not let a
 *      caller reach a connection outside the unit they are authorised for
 */
describe("a unit's channel means one thing", () => {
  it("refuses when the configured connection is down, even with another up in the unit", async () => {
    let usedFindFirst = false;
    let created = false;
    const client = fakeClient({
      configuredConnection: { id: "conn-configured", unitId: "unit-1", connectionState: "DISCONNECTED" },
      connectionByUnit: { id: "conn-other", connectionState: "CONNECTED" },
      onFindFirst: () => {
        usedFindFirst = true;
      },
      onCreate: () => {
        created = true;
      },
    });

    expect(await open(client, "11999990000")).toEqual({ status: "channel_down" });
    expect(created).toBe(false);
    // Not merely the right answer, but reached the right way. A findFirst here IS the
    // defect, and it would give the right answer again the moment the two rows agreed.
    expect(usedFindFirst).toBe(false);
  });

  it("creates when the configured connection is up, whatever the other one says", async () => {
    const client = fakeClient({
      configuredConnection: { id: "conn-configured", unitId: "unit-1", connectionState: "CONNECTED" },
      connectionByUnit: { id: "conn-other", connectionState: "DISCONNECTED" },
    });

    expect((await open(client, "11999990000")).status).toBe("created");
  });

  it("refuses when the configured connection belongs to another unit", async () => {
    // `unitId` survives as an authorisation scope rather than a selector. It is
    // membership-checked upstream by the auth hook, so it must still bound what the
    // caller can reach; resolving by instance alone would ignore that.
    const client = fakeClient({
      configuredConnection: { id: "conn-configured", unitId: "unit-2", connectionState: "CONNECTED" },
    });

    expect(await open(client, "11999990000")).toEqual({ status: "channel_down" });
  });
});
