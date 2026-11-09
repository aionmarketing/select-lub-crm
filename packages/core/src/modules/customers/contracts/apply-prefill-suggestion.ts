/**
 * `applyPrefillSuggestion` — writes one accepted prefill suggestion into the
 * cadastro: the only way `prefill` (4C) writes a customer or vehicle.
 *
 * Wraps `persistPrefillAccept` from `cadastro-engine` (absorbed from
 * `@select-lub/omie` in 5.1b), the function the old prefill accept called, unchanged: version and year
 * write the titular vehicle locally; on a customer linked to Omie, a shared field
 * goes through `applyCrmEdit` and pushes to Omie synchronously; on an unlinked
 * customer it saves locally and bumps the local sync version. Store writes run
 * under `module_customers` (the cadastro store); the Omie push goes through the
 * adapter the caller passes, outside any transaction — the caller's own port, held
 * in its plugin closure, never a process-wide binding (W2-C6).
 *
 * The signature was fixed with the orchestrator for 4C under ruling Q1a (the
 * write-back stays synchronous), so `omie_unavailable` stays in the result. The
 * third argument, `omieAdapter`, was added in 4B review (W2-C6): nothing binds the
 * ERP port process-wide any more, so the caller hands in the adapter it was given.
 */
import { customerToDto } from "./cadastro-dto.js";
import { persistPrefillAccept } from "./cadastro-engine/index.js";
import type { OmieAdapter } from "../../../kernel/clients/erp-mock.js";
import type { Customer } from "./http.customer.js";
import type { PrefillFieldKey } from "../../prefill/contracts/http.js";
import type { Db } from "../../../kernel/db.js";
import { publish } from "../../../kernel/events.js";
import { createCadastroStore } from "./cadastro-store/index.js";
import { customerChanged } from "./customer-changed.js";

/** One accepted suggestion. */
export type ApplyPrefillSuggestionInput = {
  customerId: string;
  unitId: string;
  field: PrefillFieldKey;
  value: string | number;
  actorId?: string;
};

/** How the accept went; the customer is the saved CRM row either way. */
export type ApplyPrefillSuggestionResult =
  | { status: "ok"; customer: Customer }
  | { status: "not_found" }
  | { status: "unit_mismatch" }
  | { status: "not_linked" }
  | { status: "omie_unavailable"; customer: Customer };

/**
 * Writes one accepted suggestion.
 *
 * @param db - The database handle.
 * @param input - The customer, the caller's unit, the field and its value, and the actor.
 * @param omieAdapter - The Omie adapter a linked customer's shared field is pushed through.
 * @returns The saved customer (`ok`, or `omie_unavailable` when the push failed after
 *   the CRM save), or why nothing was written.
 */
export async function applyPrefillSuggestion(
  db: Db,
  input: ApplyPrefillSuggestionInput,
  omieAdapter: OmieAdapter,
): Promise<ApplyPrefillSuggestionResult> {
  const result = await persistPrefillAccept(createCadastroStore(db), omieAdapter, input);
  if (result.status !== "ok" && result.status !== "omie_unavailable") {
    return result;
  }
  await publish(customerChanged, {
    customerId: result.customer.id,
    unitId: input.unitId,
    fields: [input.field],
    actorId: input.actorId ?? null,
    source: "prefill-accept",
  });
  return { status: result.status, customer: customerToDto(result.customer) };
}
