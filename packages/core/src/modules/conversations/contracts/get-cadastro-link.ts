/**
 * Reading a conversation's cadastro link: its id, its phone (the chat key) and
 * the customer it is linked to.
 *
 * `customers`' cadastro slices (4B) and prefill (4C) read it before they resolve
 * or link a customer; the tag and template slices read it as their loja gate.
 * Moved from the api's conversations store (`getCadastroLink`, 4A). 4B wrote a
 * stub at this path from the accepted signature; this replaces it, same
 * signature and behaviour.
 *
 * Scoped to the caller's loja: a conversation in another unit answers as a
 * missing one, so the read never confirms that it exists.
 */
import type { Db } from "../../../kernel/db.js";

/** A thread's cadastro linkage. */
export type CadastroLink = {
  /** The conversation id. */
  id: string;
  /** The thread's canonical phone, its chat key. */
  phone: string;
  /** The linked customer, or null. */
  customerId: string | null;
};

/**
 * Reads a thread's phone and linked customer.
 *
 * @param db - The database handle; runs on `db.tx("conversations", …)`.
 * @param input.conversationId - The conversation.
 * @param input.unitId - The caller's loja.
 * @returns The linkage, or null when the conversation is missing or in another unit.
 */
export async function getCadastroLink(
  db: Db,
  input: { conversationId: string; unitId: string },
): Promise<CadastroLink | null> {
  const conversation = await db.tx("conversations", (tx) =>
    tx.conversation.findFirst({
      where: { id: input.conversationId, whatsappConnection: { unitId: input.unitId } },
      select: { id: true, customerId: true, chatKey: true },
    }),
  );
  if (!conversation) {
    return null;
  }
  return { id: conversation.id, phone: conversation.chatKey, customerId: conversation.customerId };
}
