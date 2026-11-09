/**
 * Test design (testing-strategy) — conversations / list-conversations, store level
 *
 * Moved from `apps/api/src/conversations/prisma.test.ts` (4A), assertions
 * unchanged: its three `list()` cases. `store.list(unitId, query)` is now
 * `listConversations(db, unitId, query)`; the fake client is the same, handed to
 * each `db.tx` callback by a fake `Db`, so no Postgres and no role. The route
 * over a real database is this slice's integration tests.
 *
 * Setup: `listConversations` over a fake PrismaClient.
 *
 * Sampled-cell
 *   list q vs chatKey digits  | D5 | hit and miss | digits ignored
 *   list q vs customer name   | D6 | hit | name ignored
 *   stage cut                 | D7 | cumulative | exact equality
 *
 * Decision map (list-conversations/queries.ts)
 *   D5 q digits vs chatKey.includes — hit vs miss
 *   D6 q vs linked customer name (case-insensitive) — hit
 *   D7 stage === undefined ? summaries : filter(pipelineStageReached) — the
 *      filtered branch, sampled directly; the unfiltered one is every other case
 */
import type { PrismaClient } from "@select-lub/core/db";
import { describe, expect, it } from "vitest";
import type { Db } from "../../../../kernel/db.js";
import { listConversations } from "../index.js";

type Row = {
  id: string;
  chatKey: string;
  customerId: string | null;
  lastMessageAt: Date;
  sourceType: string;
  // providerTimestamp is optional because most fixtures seed a single message,
  // which hasPendingShouldReply's sort never compares — but a multi-message row
  // needs it (see the stage-cut `it`).
  messages: { direction: string; messageType: string; textBody: string | null; providerTimestamp?: Date }[];
};

function fakeClient(options: {
  listRows?: Row[];
  customers?: { id: string; name: string }[];
  // The two funnel facts the list read joins for the derived pipeline stage.
  quotedConversationIds?: string[];
  attributedConversationIds?: string[];
}): PrismaClient {
  return {
    customer: { findMany: async () => options.customers ?? [] },
    oilQuote: {
      findMany: async () => (options.quotedConversationIds ?? []).map((conversationId) => ({ conversationId })),
    },
    serviceConversationAttribution: {
      findMany: async () => (options.attributedConversationIds ?? []).map((conversationId) => ({ conversationId })),
    },
    conversation: { findMany: async () => options.listRows ?? [] },
  } as unknown as PrismaClient;
}

/** A `Db` whose every transaction runs on the fake client. */
function fakeDb(client: PrismaClient): Db {
  return { tx: (_module: string, fn: (tx: PrismaClient) => unknown) => fn(client) } as unknown as Db;
}

describe("listConversations", () => {
  it("list() matches q against chatKey digits", async () => {
    const db = fakeDb(
      fakeClient({
        listRows: [
          {
            id: "conv-hit",
            chatKey: "5511999999999",
            customerId: null,
            lastMessageAt: new Date("2026-08-28T12:00:00.000Z"),
            sourceType: "UNKNOWN",
            messages: [{ direction: "inbound", messageType: "text", textBody: "oi" }],
          },
        ],
      }),
    );

    const hit = await listConversations(db, "unit-1", { q: "5511999999999" });
    expect(hit.map((row) => row.id)).toEqual(["conv-hit"]);

    const miss = await listConversations(db, "unit-1", { q: "00000" });
    expect(miss).toEqual([]);
  });

  it("list() applies the cumulative stage cut, not exact equality", async () => {
    const db = fakeDb(
      fakeClient({
        listRows: [
          {
            id: "conv-novo",
            chatKey: "5511900000001",
            customerId: null,
            lastMessageAt: new Date("2026-08-28T12:00:00.000Z"),
            sourceType: "UNKNOWN",
            messages: [{ direction: "inbound", messageType: "text", textBody: "oi" }],
          },
          {
            id: "conv-atendimento",
            chatKey: "5511900000002",
            customerId: null,
            lastMessageAt: new Date("2026-08-28T12:05:00.000Z"),
            sourceType: "UNKNOWN",
            messages: [
              {
                direction: "outbound",
                messageType: "text",
                textBody: "olá",
                providerTimestamp: new Date("2026-08-28T12:05:00.000Z"),
              },
              {
                direction: "inbound",
                messageType: "text",
                textBody: "oi",
                providerTimestamp: new Date("2026-08-28T12:00:00.000Z"),
              },
            ],
          },
        ],
      }),
    );

    // novosContatos is the floor: both rows are at or past it.
    const atFloor = await listConversations(db, "unit-1", { stage: "novosContatos" });
    expect(atFloor.map((row) => row.id).sort()).toEqual(["conv-atendimento", "conv-novo"]);

    // emAtendimento excludes the inbound-only row, which never advanced past it.
    const higherFloor = await listConversations(db, "unit-1", { stage: "emAtendimento" });
    expect(higherFloor.map((row) => row.id)).toEqual(["conv-atendimento"]);
  });

  it("list() matches q against linked customer name", async () => {
    const db = fakeDb(
      fakeClient({
        customers: [{ id: "cust-1", name: "Maria Silva" }],
        listRows: [
          {
            id: "conv-named",
            chatKey: "5511999999999",
            customerId: "cust-1",
            lastMessageAt: new Date("2026-08-28T12:00:00.000Z"),
            sourceType: "UNKNOWN",
            messages: [{ direction: "inbound", messageType: "text", textBody: "oi" }],
          },
        ],
      }),
    );

    const hit = await listConversations(db, "unit-1", { q: "maria" });
    expect(hit.map((row) => row.id)).toEqual(["conv-named"]);
  });
});
