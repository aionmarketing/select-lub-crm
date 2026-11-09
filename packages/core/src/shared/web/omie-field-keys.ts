/**
 * The shared fields the CRM and Omie keep in sync. The kernel's ERP port and the customers
 * module both name them, so they live in the shared kernel.
 *
 * Moved from `packages/shared-types/src/omie-sync.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";

/** Field keys that exist on both CRM and Omie records and may diverge during sync. */
export const omieSharedFieldKeySchema = z.enum([
  "name",
  "taxId",
  "primaryPhone",
  "primaryEmail",
  "street",
  "streetNumber",
  "neighborhood",
  "complement",
  "city",
  "state",
  "postalCode",
  "country",
  "plate",
  "make",
  "model",
  "odometerKm",
]);

/** Field key shared by CRM and Omie records that may diverge during sync. */
export type OmieSharedFieldKey = z.infer<typeof omieSharedFieldKeySchema>;
