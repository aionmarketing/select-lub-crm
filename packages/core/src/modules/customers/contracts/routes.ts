/**
 * The customers routes' own schemas: path params, the empty refusal body, and the two
 * pending-list responses. Server-only — not part of the web contract (`http.ts`), which
 * is why they moved out of it in 5.1d; they were `apps/api/src/http/schemas.ts`'s before 4B.
 */
import { z } from "zod";
import { globalReconciliationPendingSchema, reconciliationPendingSchema } from "./http.omie-sync.js";

/** `:id` of a customer. */
export const customerIdParams = z.object({ id: z.string().min(1) });
/** `:id` of a vehicle. */
export const vehicleIdParams = z.object({ id: z.string().min(1) });
/** `:id` of a conversation. */
export const conversationIdParams = z.object({ id: z.string().min(1) });
/** The empty body of a 404, 409 or other refusal. */
export const notFoundBody = z.object({});
/** A customer's open reconciliation pendings. */
export const pendingListSchema = z.array(reconciliationPendingSchema);
/** A unit's open reconciliation pendings, each with its customer's display name. */
export const globalPendingListSchema = z.array(globalReconciliationPendingSchema);
