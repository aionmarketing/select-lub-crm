/**
 * Accepting one suggested field: write it to the customer through `customers`'
 * contract, then drop it from the pending suggestion. Shared by the per-field
 * and the accept-all routes, which did the same two steps inline in
 * `apps/api/src/prefill/routes.ts`.
 */
import type { OmieAdapter } from "../../../kernel/clients/erp-mock.js";
import type { PrefillFieldKey } from "../contracts/http.js";
import type { Db } from "../../../kernel/db.js";
import { applyPrefillSuggestion } from "../../customers/contracts/apply-prefill-suggestion.js";
import { stripField } from "./suggestion.js";

/** What accepting one field came to. */
export type AcceptFieldOutcome = "accepted" | "not_found" | "not_linked";

/**
 * Applies one field and, if the customer took it, strips it from the suggestion.
 *
 * `applyPrefillSuggestion` pushes to Omie synchronously; it is called here with
 * no transaction of prefill's open. The strip is its own `db.tx("prefill", …)`
 * afterwards. An Omie that was unavailable still counts as accepted — the field
 * was written locally — exactly as before.
 *
 * @param db - The database handle.
 * @param omieAdapter - Handed to the contract.
 * @param input - The customer, loja, field, value and acting user; the conversation to strip.
 * @returns `accepted`; `not_found` for an unknown customer or another loja's
 *   (a 404); `not_linked` for a customer not linked to Omie (a 409).
 */
export async function acceptField(
  db: Db,
  omieAdapter: OmieAdapter,
  input: {
    conversationId: string;
    customerId: string;
    unitId: string;
    field: PrefillFieldKey;
    value: string | number;
    actorId?: string;
  },
): Promise<AcceptFieldOutcome> {
  const persisted = await applyPrefillSuggestion(
    db,
    {
      customerId: input.customerId,
      unitId: input.unitId,
      field: input.field,
      value: input.value,
      ...(input.actorId ? { actorId: input.actorId } : {}),
    },
    omieAdapter,
  );
  if (persisted.status === "not_found" || persisted.status === "unit_mismatch") {
    return "not_found";
  }
  if (persisted.status === "not_linked") {
    return "not_linked";
  }
  await db.tx("prefill", (tx) => stripField(tx, input.conversationId, input.field));
  return "accepted";
}
