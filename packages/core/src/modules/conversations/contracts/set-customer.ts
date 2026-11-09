/**
 * Linking a conversation to a customer: the only way another module writes
 * `conversation.customer_id`.
 *
 * `customers`' cadastro slices (4B: `link-conversation-customer` and the rail
 * save) and prefill's accept path (4C) link the thread a customer was found or
 * created for. Moved from the api's conversations store (`setCustomerId`, 4A);
 * 4B wrote a stub at this path from the accepted signature, and this replaces
 * it, same signature and behaviour. The read beside it is
 * `get-cadastro-link.ts`.
 *
 * Scoped to the caller's loja: a conversation in another unit answers as a
 * missing one, so the write never confirms that it exists.
 */
import type { Db } from "../../../kernel/db.js";

/** Which conversation, in which loja, to link to which customer. */
export type SetCustomerInput = { conversationId: string; unitId: string; customerId: string };

/** `not_found`: missing, or in another unit. */
export type SetCustomerResult = { status: "linked" } | { status: "not_found" };

/**
 * Links a conversation to a customer, overwriting any existing link, as before.
 *
 * One `updateMany` keyed on the row and the unit: there is no read before the
 * write, so no race between them.
 *
 * @param db - The database handle; runs on `db.tx("conversations", …)`.
 * @param input.conversationId - The conversation.
 * @param input.unitId - The caller's loja.
 * @param input.customerId - The CRM customer id (not an Omie id).
 * @returns `linked`, or `not_found` when the conversation is missing or in another
 *   unit. The old `setCustomerId` returned nothing there; its callers had already
 *   answered 404 through `getCadastroLink`, so ignoring the status keeps that.
 */
export async function setCustomer(db: Db, input: SetCustomerInput): Promise<SetCustomerResult> {
  const result = await db.tx("conversations", (tx) =>
    tx.conversation.updateMany({
      where: { id: input.conversationId, whatsappConnection: { unitId: input.unitId } },
      data: { customerId: input.customerId },
    }),
  );
  return result.count > 0 ? { status: "linked" } : { status: "not_found" };
}
