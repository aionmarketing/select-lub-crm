/**
 * Fixtures shared by this slice's tests: the report windows, a nova factory, the
 * caller's unit, a recording stand-in for the unanswered-quote port, and a
 * request helper that mounts the slice on the kernel app.
 *
 * Moved from `apps/api/src/reports.route.test.ts` (`seedNova`,
 * `seedCallerUnit`, `get`). What changed is only how the app is built: the slice
 * is mounted on the kernel app through `registerSlice`, with the caller stated
 * rather than resolved by `apps/api`'s auth hook — so the hook's own cases (the
 * 403 on a unit the caller is not in) live in `apps/api/test/reports.integration.test.ts`.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@select-lub/core/db";
import { prisma } from "@select-lub/core/db";
import { createDb, registerSlice, type DbClient } from "../../../../kernel/index.js";
import {
  buildSliceApp,
  runInTransactionOnTx,
  seedConnection,
  seedUnit,
  seedUser,
} from "../../../../testing/index.js";
import {
  reportConversationsRoute,
  type InboundMessageInput,
  type ReportConversationsPorts,
  type UnansweredQuoteInput,
} from "../index.js";

/** The window the seeded novas fall in, and one they do not. */
export const MATCHING = "periodStart=2026-08-01T00:00:00.000Z&periodEnd=2026-09-01T00:00:00.000Z";
export const EMPTY = "periodStart=2025-01-01T00:00:00.000Z&periodEnd=2025-02-01T00:00:00.000Z";
export const INBOUND_AT = new Date("2026-08-10T12:00:00.000Z");
export const OUTBOUND_AT = new Date("2026-08-10T13:00:00.000Z");

/** A CRM user id for `created_by_user_id` on scheduled rows. */
export const CALLER_USER_ID = "11111111-1111-1111-1111-111111111111";

/** The singleton client the rollback harness opens its transaction on. */
export const db = () => prisma as PrismaClient;

/** A chat key no other transaction can collide on; `conversation` is unique on (connection, chatKey). */
export function chatKey(): string {
  return `5519${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "0")}`;
}

/**
 * Creates one nova on a connection.
 *
 * @param tx - The test transaction.
 * @param connectionId - Connection the conversation hangs off; its unit is the
 *   conversation's unit, and that join is what scopes the report.
 * @param options.answered - When false the conversation has no outbound, so it
 *   counts as a nova but not as answered.
 * @param options.data - Extra columns (origin, campaign, customer…).
 * @returns The conversation id.
 */
export async function seedNova(
  tx: DbClient,
  connectionId: string,
  { answered = true, data = {} }: { answered?: boolean; data?: Record<string, unknown> } = {},
): Promise<string> {
  const key = chatKey();
  const row = await tx.conversation.create({
    data: {
      whatsappConnectionId: connectionId,
      remoteJid: `${key}@s.whatsapp.net`,
      chatKey: key,
      startedAt: INBOUND_AT,
      firstInboundAt: INBOUND_AT,
      firstOutboundAt: answered ? OUTBOUND_AT : null,
      lastMessageAt: answered ? OUTBOUND_AT : INBOUND_AT,
      ...data,
    },
    select: { id: true },
  });
  return row.id;
}

/** The caller's unit, a connection in it, and a CRM user (scheduled rows need a creator). */
export async function seedCallerUnit(tx: DbClient) {
  const unit = await seedUnit(tx);
  const connection = await seedConnection(tx, { unitId: unit.id });
  await seedUser(tx, { id: CALLER_USER_ID, units: [unit.id] });
  return { unitId: unit.id, connectionId: connection.id };
}

/** A stand-in for the unanswered-quote port that answers `answer` and records what it was given. */
export function recordingPorts(answer = 0) {
  const calls: { quotes: UnansweredQuoteInput[]; inbounds: InboundMessageInput[]; unitId: string }[] = [];
  const ports: ReportConversationsPorts = {
    unansweredQuotes(quotes, inbounds, unitId) {
      calls.push({ quotes, inbounds, unitId });
      return answer;
    },
  };
  return { ports, calls };
}

/**
 * Requests the report through the slice mounted on the kernel app.
 *
 * @param tx - The test transaction; the app's `Db` writes into it.
 * @param unitId - The unit the caller is scoped to, as the hook would have
 *   resolved it. `undefined` states a caller with no scoped unit.
 * @param query - Query string, e.g. `${MATCHING}&granularity=day`.
 * @param ports - Defaults to a recorder answering 0.
 * @returns The raw response.
 */
export async function get(
  tx: DbClient,
  unitId: string | undefined,
  query: string,
  ports: ReportConversationsPorts = recordingPorts().ports,
) {
  const app = await buildSliceApp({
    db: createDb(tx, runInTransactionOnTx(tx)),
    plugin: (instance) =>
      registerSlice(instance, "reports", "report-conversations", reportConversationsRoute(ports)),
    caller: { userId: CALLER_USER_ID, unitId },
  });
  try {
    return await app.inject({ method: "GET", url: `/reports/conversations?${query}` });
  } finally {
    await app.close();
  }
}
