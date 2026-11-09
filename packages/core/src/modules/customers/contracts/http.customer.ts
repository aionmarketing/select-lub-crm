/**
 * Zod contracts for customer records, including normalized phone and email sub-objects.
 *
 * Moved from `packages/shared-types/src/customer.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";

/** Phone entry on a customer; `normalized` is the digits-only form used for matching. */
export const customerPhoneSchema = z.object({
  raw: z.string(),
  normalized: z.string(),
  isPrimary: z.boolean(),
});

/** Email entry on a customer; `normalized` is lowercased for matching. */
export const customerEmailSchema = z.object({
  raw: z.string(),
  normalized: z.string(),
  isPrimary: z.boolean(),
});

/** Response body for a customer with CRM and Omie-synced address fields. */
export const customerSchema = z.object({
  id: z.string(),
  /** CRM display name; `null` when unknown. Empty/whitespace never parses. */
  name: z.string().trim().min(1).nullable(),
  omieId: z.string().nullable(),
  taxId: z.string().nullable(),
  unitId: z.string().nullable(),
  givenName: z.string().nullable(),
  familyName: z.string().nullable(),
  mergedInto: z.string().nullable(),
  street: z.string().nullable(),
  streetNumber: z.string().nullable(),
  neighborhood: z.string().nullable(),
  complement: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string().nullable(),
  origin: z.string().trim().min(1),
  status: z.string().trim().min(1),
  phones: z.array(customerPhoneSchema).optional(),
  emails: z.array(customerEmailSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Phone entry on a customer; `normalized` is the digits-only form used for matching. */
export type CustomerPhone = z.infer<typeof customerPhoneSchema>;

/** Email entry on a customer; `normalized` is lowercased for matching. */
export type CustomerEmail = z.infer<typeof customerEmailSchema>;

/** Customer with CRM and Omie-synced address fields. */
export type Customer = z.infer<typeof customerSchema>;
