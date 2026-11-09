/**
 * Ensures a CRM 1:1 exists for the live dest, matching Nova conversa (no WhatsApp send).
 *
 * `5519000000002` is the paired POC number. Seed/scrub wipes live ingest, so the
 * suite creates the row when missing rather than skipping.
 */
import type { PrismaClient } from "@select-lub/core/db";
import { LIVE_SCHEDULE_CHAT_KEY, LIVE_SCHEDULE_REMOTE_JID } from "./ids.js";
import type { LiveScheduleConversation } from "./gate.js";

/**
 * Finds or creates the live dest conversation on the named Evolution instance.
 *
 * @param prisma - Open client pointed at the gated local database
 * @param instanceName - `EVOLUTION_INSTANCE_NAME` (unencoded panel name)
 * @returns The conversation to drive, or a fail message when the instance is missing or not `CONNECTED`
 */
export async function ensureLiveConversation(
  prisma: PrismaClient,
  instanceName: string,
): Promise<{ kind: "ready"; conversation: LiveScheduleConversation } | { kind: "fail"; message: string }> {
  const connection = await prisma.whatsAppConnection.findUnique({
    where: { instanceName },
  });
  if (!connection) {
    return { kind: "fail", message: `no WhatsApp connection named ${instanceName}` };
  }
  if (connection.connectionState !== "CONNECTED") {
    return {
      kind: "fail",
      message: `instance is not CONNECTED (${connection.connectionState})`,
    };
  }

  const existing = await prisma.conversation.findUnique({
    where: {
      whatsappConnectionId_chatKey: {
        whatsappConnectionId: connection.id,
        chatKey: LIVE_SCHEDULE_CHAT_KEY,
      },
    },
  });
  if (existing) {
    return {
      kind: "ready",
      conversation: {
        id: existing.id,
        chatKey: existing.chatKey,
        customerId: existing.customerId,
        unitId: connection.unitId,
        connectionState: connection.connectionState,
      },
    };
  }

  const now = new Date();
  const created = await prisma.conversation.create({
    data: {
      whatsappConnectionId: connection.id,
      remoteJid: LIVE_SCHEDULE_REMOTE_JID,
      chatKey: LIVE_SCHEDULE_CHAT_KEY,
      startedAt: now,
      lastMessageAt: now,
    },
  });
  return {
    kind: "ready",
    conversation: {
      id: created.id,
      chatKey: created.chatKey,
      customerId: created.customerId,
      unitId: connection.unitId,
      connectionState: connection.connectionState,
    },
  };
}
