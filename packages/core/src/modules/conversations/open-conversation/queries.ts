/**
 * Nova conversa: opens a thread for a phone on the configured connection, or
 * reopens the one that number already has.
 *
 * Moved from `create()` in `apps/api/src/conversations/prisma.ts` (4A). One
 * change: a create that loses the `(whatsapp_connection_id, chat_key)` unique
 * index to a concurrent writer — the webhook ingest opening the same thread as
 * the attendant clicks — used to surface as a 500; it now re-reads and answers
 * `existing`. The conflict is caught after its `db.tx` has rolled back, never
 * inside the callback.
 */
import { Prisma } from "@prisma/client";
import { conversationChatKeyFromJid, conversationListSnippet, type ConversationMessage } from "../contracts/http.js";
import type { ConversationSourceType } from "../../reports/contracts/http.js";
import type { Db } from "../../../kernel/db.js";
import { summaryFrom, type CreateConversationResult } from "../internal/conversation-dto.js";

async function findExisting(db: Db, connectionId: string, chatKey: string): Promise<CreateConversationResult | null> {
  const existing = await db.tx("conversations", (tx) =>
    tx.conversation.findUnique({
      where: { whatsappConnectionId_chatKey: { whatsappConnectionId: connectionId, chatKey } },
      include: { messages: { orderBy: { providerTimestamp: "desc" }, take: 1 } },
    }),
  );
  if (!existing) {
    return null;
  }
  return {
    status: "existing",
    conversation: summaryFrom({
      id: existing.id,
      phone: existing.chatKey,
      lastSnippet: conversationListSnippet(
        (existing.messages[0]?.messageType as ConversationMessage["messageType"]) ?? "text",
        existing.messages[0]?.textBody ?? null,
      ),
      lastMessageAt: existing.lastMessageAt,
      sourceType: existing.sourceType as ConversationSourceType,
    }),
  };
}

/**
 * Opens or reopens the thread for `phone`.
 *
 * @param db - The database handle; each read and the insert run in their own
 *   `db.tx("conversations", …)`.
 * @param input.unitId - The request's loja: an authorisation scope, not a
 *   selector.
 * @param input.instanceName - The configured Evolution instance.
 * @param input.phone - As typed; non-digits are dropped.
 * @returns `channel_down` unless the configured connection is this loja's and
 *   its STORED state is `CONNECTED`; else the thread, `created` or `existing`.
 */
export async function openConversation(
  db: Db,
  input: { unitId: string; instanceName: string; phone: string },
): Promise<CreateConversationResult> {
  // The configured instance, exactly as the channel status route resolves it.
  // This was once `findFirst({ where: { unitId } })`, unordered: a unit holding
  // two connections could read Conectado on the screen while Nova conversa
  // refused, or the reverse, and the chosen row also decided which instance a
  // brand new thread was attached to. The STORED column decides here; the send
  // routes ask the live probe (the two-source rule).
  const connection = await db.tx("conversations", (tx) =>
    tx.whatsAppConnection.findUnique({
      where: { instanceName: input.instanceName },
      select: { id: true, unitId: true, connectionState: true },
    }),
  );
  // `unitId` is an authorisation scope rather than a selector: the auth hook
  // membership-checks the header upstream, and resolving by instance alone would
  // let a caller authorised for one unit reach another unit's connection.
  if (!connection || connection.unitId !== input.unitId || connection.connectionState !== "CONNECTED") {
    return { status: "channel_down" };
  }
  const digits = conversationChatKeyFromJid(input.phone) ?? "";
  const existing = await findExisting(db, connection.id, digits);
  if (existing) {
    return existing;
  }
  const now = new Date();
  try {
    const created = await db.tx("conversations", (tx) =>
      tx.conversation.create({
        data: {
          whatsappConnectionId: connection.id,
          remoteJid: `${digits}@s.whatsapp.net`,
          chatKey: digits,
          startedAt: now,
          lastMessageAt: now,
        },
      }),
    );
    return {
      status: "created",
      conversation: summaryFrom({
        id: created.id,
        phone: created.chatKey,
        lastSnippet: "",
        lastMessageAt: created.lastMessageAt,
        sourceType: created.sourceType as ConversationSourceType,
      }),
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await findExisting(db, connection.id, digits);
      if (raced) {
        return raced;
      }
    }
    throw error;
  }
}
