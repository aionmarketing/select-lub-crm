/**
 * The loja gate every conversation route passes first: a conversation belongs to
 * a loja through `conversation → whatsapp_connection → unit_id`.
 *
 * Moved from the `findFirst({ where: { id, whatsappConnection: { unitId } } })`
 * each method of `apps/api/src/conversations/prisma.ts` repeated (4A).
 */
import type { Db } from "../../../kernel/db.js";

/** A conversation the loja may read, with the instance its connection runs on. */
export type ScopedConversation = { id: string; instanceName: string };

/**
 * Finds a conversation of the loja.
 *
 * @param db - The database handle; the read runs in `db.tx("conversations", …)`.
 * @param unitId - The request's loja.
 * @param conversationId - The path id.
 * @returns The conversation and its connection's instance name, or null when the
 *   id is unknown or another loja's.
 */
export async function findConversationInUnit(
  db: Db,
  unitId: string,
  conversationId: string,
): Promise<ScopedConversation | null> {
  const row = await db.tx("conversations", (tx) =>
    tx.conversation.findFirst({
      where: { id: conversationId, whatsappConnection: { unitId } },
      select: { id: true, whatsappConnection: { select: { instanceName: true } } },
    }),
  );
  return row ? { id: row.id, instanceName: row.whatsappConnection.instanceName } : null;
}
