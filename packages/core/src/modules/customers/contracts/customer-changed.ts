/**
 * `customers/customer-changed` — an attendant's edit changed a customer's fields.
 *
 * Published after the CRM save, where today's edits happen: `PATCH /customers/:id`,
 * the rail's first save (`POST /conversations/:id/customer`), resolving a
 * reconciliation pending, and accepting a prefill suggestion. It is published
 * whether or not the synchronous push to Omie succeeded: the CRM row changed
 * either way.
 *
 * NO SUBSCRIBER YET, on purpose (4B ruling Q1a). The write-back to Omie stays
 * synchronous in this move — the engine pushes inline through the plugin's Omie adapter, and
 * the route still answers 503 when Omie is unreachable. Making `erp`'s
 * `enqueue-write` consume this event turns the write-back asynchronous, which
 * changes observable behaviour (the 503, the Contato card's "Omie unreachable"
 * state, the web's error path) and needs its own openspec change. Until then
 * `erp/drain-outbox` stays unregistered.
 */
import { z } from "zod";
import { defineEvent } from "../../../kernel/events.js";

/** What changed, where, and who changed it. */
export const customerChangedSchema = z.object({
  customerId: z.string().min(1),
  unitId: z.string().min(1),
  /**
   * The cadastro fields the edit carried. A prefill accept may name a titular
   * vehicle field (plate, make, model, version, year, odometer): the Omie client
   * record carries those, so they are part of the customer's write-back unit.
   */
  fields: z.array(z.string().min(1)).min(1),
  /** The attendant, or `null` when the edit had no known actor. */
  actorId: z.string().nullable(),
  /** Which kind of edit it was. */
  source: z.enum(["edit", "pending-resolve", "prefill-accept"]),
});

/** The payload of {@link customerChanged}. */
export type CustomerChanged = z.infer<typeof customerChangedSchema>;

/** Published by the customer-edit slices and `applyPrefillSuggestion`. */
export const customerChanged = defineEvent<CustomerChanged>(
  "customers/customer-changed",
  customerChangedSchema,
);
