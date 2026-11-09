/**
 * Resolves the customer a conversation's cadastro belongs to.
 *
 * Moved from `apps/api/src/http/cadastro-link.ts` (4B). The conversation is read
 * through the conversations module's `getCadastroLink` contract, which keeps the
 * unit join in one place; the rule is unchanged: the linked customer when it is in
 * the caller's unit, else a customer of that unit with the conversation's phone.
 */
import type { CustomerRecord } from "../contracts/cadastro-store/port.js";
import type { Db } from "../../../kernel/db.js";
import { getCadastroLink } from "../../conversations/contracts/get-cadastro-link.js";
import { createCadastroStore } from "../contracts/cadastro-store/index.js";

/**
 * Finds the customer behind a conversation, scoped to the caller's unit.
 *
 * @param db - The database handle.
 * @param unitId - The caller's unit.
 * @param conversationId - The conversation.
 * @returns `missing` when the conversation is not in the unit; else the customer, or `null`.
 */
export async function resolveCadastroCustomer(
  db: Db,
  unitId: string,
  conversationId: string,
): Promise<{ missing: true } | { missing: false; customer: CustomerRecord | null }> {
  const cadastro = createCadastroStore(db);
  const link = await getCadastroLink(db, { conversationId, unitId });
  if (!link) {
    return { missing: true };
  }
  let customer = null;
  if (link.customerId) {
    const byId = await cadastro.getCustomer(link.customerId);
    if (byId && byId.unitId === unitId) {
      customer = byId;
    }
  }
  if (!customer) {
    customer = await cadastro.findCustomerByPhone(unitId, link.phone);
  }
  return { missing: false, customer };
}
