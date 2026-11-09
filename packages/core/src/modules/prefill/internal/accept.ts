/**
 * Shared customer resolution and pending-field walk for per-field and accept-all prefill writes.
 *
 * Moved from `apps/api/src/prefill/accept.ts`. The customer is now resolved and
 * created through `customers`' `createCadastroStore` contract (each call under
 * `module_customers`) and the thread linked through `conversations`'
 * `setCustomer` (under `module_conversations`), in place of the api's cadastro
 * store and 4A's conversation-link shim. Same steps, same order.
 */
import type { CustomerRecord } from "../../customers/contracts/cadastro-store/port.js";
import { prefillFieldKeySchema, type PrefillFieldKey, type PrefillFields } from "../contracts/http.js";
import type { Db } from "../../../kernel/db.js";
import type { CadastroLink } from "../../conversations/contracts/get-cadastro-link.js";
import { setCustomer } from "../../conversations/contracts/set-customer.js";
import { createCadastroStore } from "../../customers/contracts/cadastro-store/index.js";

/**
 * Pending suggestion keys in the closed v1 field order, so accept-all is sequential-equivalent to clicking Aceitar top-to-bottom.
 *
 * @param fields - Current suggested cadastro fields; missing keys are skipped.
 * @returns Field/value pairs only for keys present on `fields`.
 */
export function pendingPrefillEntries(fields: PrefillFields): Array<{
  field: PrefillFieldKey;
  value: string | number;
}> {
  const entries: Array<{ field: PrefillFieldKey; value: string | number }> = [];
  for (const field of prefillFieldKeySchema.options) {
    if (!Object.hasOwn(fields, field)) {
      continue;
    }
    const value = fields[field];
    if (value !== undefined) {
      entries.push({ field, value });
    }
  }
  return entries;
}

/**
 * Resolves the conversation customer (linked id, then phone match) or creates a local WhatsApp cadastro once.
 *
 * Each step is its own owner's transaction; none holds one open across the next.
 *
 * @param db - The database handle.
 * @param unitId - Caller unit; must match the customer.
 * @param link - Conversation cadastro link (`id` is the conversation id).
 * @returns The resolved or newly created customer record.
 */
export async function resolveOrCreatePrefillCustomer(
  db: Db,
  unitId: string,
  link: CadastroLink,
): Promise<CustomerRecord> {
  const cadastroStore = createCadastroStore(db);
  let customer = null;
  if (link.customerId) {
    const byId = await cadastroStore.getCustomer(link.customerId);
    if (byId && byId.unitId === unitId) {
      customer = byId;
    }
  }
  if (!customer) {
    customer = await cadastroStore.findCustomerByPhone(unitId, link.phone);
  }
  if (!customer) {
    const created = await cadastroStore.createWhatsappCadastro({
      unitId,
      phoneNormalized: link.phone,
      phoneRaw: link.phone,
    });
    customer = created.customer;
  }
  if (!link.customerId || link.customerId !== customer.id) {
    await setCustomer(db, { conversationId: link.id, unitId, customerId: customer.id });
  }
  return customer;
}
