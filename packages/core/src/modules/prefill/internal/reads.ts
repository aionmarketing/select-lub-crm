/**
 * The reads the prefill job makes. Moved from `apps/worker/src/prefill/prisma.ts`
 * (`resolveCadastro`, `listRecentTextMessages`, `getSuggestionFields`,
 * `listWindowScan`, `getWindowState`, `findInFlightJob`), queries unchanged.
 *
 * Each takes the client of its caller's `db.tx("prefill", …)`. They read
 * prefill's own tables and, under `readableBy`, `conversation` and `message`
 * (conversations'), `customer`, `customer_phone`, `vehicle` and
 * `vehicle_field_sync` (customers').
 */
import type { PrefillFields } from "../contracts/http.js";
import type { DbClient } from "../../../kernel/db.js";
import {
  PREFILL_PLATE_SOURCED_KEYS,
  selectPlateSourcedKeys,
  type PrefillCadastroSnapshot,
  type PrefillJob,
  type PrefillJobStatus,
  type PrefillTextLine,
  type PrefillWindowScanRow,
} from "./cadastro-snapshot.js";
import type { WindowMessage } from "./window.js";

/** A job row as the drain sees it. */
export function toJob(row: {
  id: string;
  conversationId: string;
  status: string;
  dirty: boolean;
  lastError: string | null;
  windowLatestInboundAt: Date | null;
}): PrefillJob {
  return {
    id: row.id,
    conversationId: row.conversationId,
    status: row.status as PrefillJobStatus,
    dirty: row.dirty,
    lastError: row.lastError,
    windowLatestInboundAt: row.windowLatestInboundAt,
  };
}

function toWindowMessage(row: {
  id: string;
  direction: string;
  messageType: string;
  textBody: string | null;
  providerTimestamp: Date;
}): WindowMessage {
  return {
    id: row.id,
    direction: row.direction as "inbound" | "outbound",
    messageType: row.messageType,
    textBody: row.textBody,
    providerTimestamp: row.providerTimestamp,
  };
}

/** The message columns a window is derived from, oldest first. */
const WINDOW_MESSAGES = {
  select: { id: true, direction: true, messageType: true, textBody: true, providerTimestamp: true },
  orderBy: { providerTimestamp: "asc" },
} as const;

/**
 * Loads the stored customer and titular-vehicle fields that gate and prompt
 * extraction, including the plate-sourced keys.
 *
 * The customer is the conversation's linked one in its loja, else the latest
 * customer in that loja with the thread's phone. The titular vehicle is the
 * customer's oldest.
 *
 * @param tx - A client under `module_prefill`.
 * @param conversationId - The conversation.
 * @returns The snapshot, empty fields when no customer matches; null when the
 *   conversation is missing.
 */
export async function resolveCadastro(
  tx: DbClient,
  conversationId: string,
): Promise<PrefillCadastroSnapshot | null> {
  const conversation = await tx.conversation.findUnique({
    where: { id: conversationId },
    include: { whatsappConnection: { select: { unitId: true } } },
  });
  if (!conversation) {
    return null;
  }
  const phoneNormalized = conversation.chatKey;
  const unitId = conversation.whatsappConnection.unitId;
  let customer = conversation.customerId
    ? await tx.customer.findFirst({ where: { id: conversation.customerId, unitId } })
    : null;
  if (!customer) {
    const phone = await tx.customerPhone.findFirst({
      where: { normalized: phoneNormalized, customer: { unitId } },
      orderBy: { updatedAt: "desc" },
      include: { customer: true },
    });
    customer = phone?.customer ?? null;
  }
  if (!customer) {
    return {
      customerId: null,
      phoneNormalized,
      name: null,
      taxId: null,
      plate: null,
      make: null,
      model: null,
      version: null,
      year: null,
      odometerKm: null,
      plateSourcedKeys: [],
    } satisfies PrefillCadastroSnapshot;
  }
  const vehicle = await tx.vehicle.findFirst({
    where: { customerId: customer.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const syncRows = vehicle
    ? await tx.vehicleFieldSync.findMany({
        where: { vehicleId: vehicle.id, origin: "PLACA", fieldKey: { in: [...PREFILL_PLATE_SOURCED_KEYS] } },
        select: { fieldKey: true, origin: true },
      })
    : [];
  return {
    customerId: customer.id,
    phoneNormalized,
    name: customer.name,
    taxId: customer.taxId,
    plate: vehicle?.plate ?? null,
    make: vehicle?.make ?? null,
    model: vehicle?.model ?? null,
    version: vehicle?.version ?? null,
    year: vehicle?.year ?? null,
    odometerKm: vehicle?.odometerKm ?? null,
    plateSourcedKeys: selectPlateSourcedKeys(syncRows),
  };
}

/**
 * The most recent non-empty text lines, oldest first, for the prompt.
 *
 * @param tx - A client under `module_prefill`.
 * @param conversationId - The conversation.
 * @param limit - How many lines to read.
 */
export async function listRecentTextMessages(
  tx: DbClient,
  conversationId: string,
  limit: number,
): Promise<PrefillTextLine[]> {
  const rows = await tx.message.findMany({
    where: { conversationId, textBody: { not: null } },
    orderBy: { providerTimestamp: "desc" },
    take: limit,
    select: { id: true, direction: true, textBody: true, providerTimestamp: true },
  });
  return rows
    .filter((row) => row.textBody && row.textBody.trim() !== "")
    .reverse()
    .map((row) => ({
      id: row.id,
      direction: row.direction as "inbound" | "outbound",
      textBody: row.textBody as string,
      providerTimestamp: row.providerTimestamp,
    }));
}

/**
 * The pending suggestion's fields, or `{}` when there is none.
 *
 * @param tx - A client under `module_prefill`.
 * @param conversationId - The conversation.
 */
export async function getSuggestionFields(tx: DbClient, conversationId: string): Promise<PrefillFields> {
  const row = await tx.cadastroPrefillSuggestion.findUnique({
    where: { conversationId },
    select: { fields: true },
  });
  return (row?.fields ?? {}) as PrefillFields;
}

/**
 * Every conversation with its watermark, switch and messages, for the scan.
 *
 * Unscoped and unbounded, as before: it reads every conversation and every
 * message. Unchanged by this move.
 *
 * @param tx - A client under `module_prefill`.
 */
export async function listWindowScan(tx: DbClient): Promise<PrefillWindowScanRow[]> {
  const rows = await tx.conversation.findMany({
    select: {
      id: true,
      lastPrefillWindowClosedAt: true,
      prefillExtractEnabled: true,
      messages: WINDOW_MESSAGES,
    },
  });
  return rows.map((row) => ({
    conversationId: row.id,
    lastPrefillWindowClosedAt: row.lastPrefillWindowClosedAt,
    prefillExtractEnabled: row.prefillExtractEnabled,
    messages: row.messages.map(toWindowMessage),
  }));
}

/**
 * One conversation's watermark, switch and messages, for the drain's re-derive.
 *
 * @param tx - A client under `module_prefill`.
 * @param conversationId - The conversation.
 * @returns The row, or null when the conversation is missing.
 */
export async function getWindowState(
  tx: DbClient,
  conversationId: string,
): Promise<PrefillWindowScanRow | null> {
  const row = await tx.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      lastPrefillWindowClosedAt: true,
      prefillExtractEnabled: true,
      messages: WINDOW_MESSAGES,
    },
  });
  if (!row) {
    return null;
  }
  return {
    conversationId: row.id,
    lastPrefillWindowClosedAt: row.lastPrefillWindowClosedAt,
    prefillExtractEnabled: row.prefillExtractEnabled,
    messages: row.messages.map(toWindowMessage),
  };
}

/**
 * The conversation's queued or running job, if any.
 *
 * @param tx - A client under `module_prefill`.
 * @param conversationId - The conversation.
 */
export async function findInFlightJob(tx: DbClient, conversationId: string): Promise<PrefillJob | null> {
  const row = await tx.cadastroPrefillJob.findFirst({
    where: { conversationId, status: { in: ["queued", "running"] } },
  });
  return row ? toJob(row) : null;
}
