/**
 * Zod contracts for bidirectional CRM–Omie field sync and reconciliation workflows.
 *
 * Moved from `packages/shared-types/src/omie-sync.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";
import { type OmieSharedFieldKey, omieSharedFieldKeySchema } from "../../../shared/web/omie-field-keys.js";
import { customerSchema } from "./http.customer.js";

const nullableString = z.string().nullable();

/** Request body for patching customer or vehicle fields from the conversation rail. */
export const customerFieldEditSchema = z.object({
  name: z.string().trim().min(1).optional(),
  taxId: nullableString.optional(),
  primaryPhone: z.string().trim().min(1).optional(),
  primaryEmail: z.string().trim().min(1).optional(),
  street: nullableString.optional(),
  streetNumber: nullableString.optional(),
  neighborhood: nullableString.optional(),
  complement: nullableString.optional(),
  city: nullableString.optional(),
  state: nullableString.optional(),
  postalCode: nullableString.optional(),
  country: nullableString.optional(),
  plate: nullableString.optional(),
  make: nullableString.optional(),
  model: nullableString.optional(),
  odometerKm: z.number().nullable().optional(),
  givenName: nullableString.optional(),
  familyName: nullableString.optional(),
  mergedInto: nullableString.optional(),
});

/** Open reconciliation row comparing CRM and Omie values for one shared field. */
export const reconciliationPendingSchema = z.object({
  fieldKey: omieSharedFieldKeySchema,
  crmValue: z.string(),
  omieValue: z.string(),
  status: z.literal("open"),
  customerId: z.string(),
  vehicleId: z.string().nullable(),
});

const pendingResolveBase = {
  fieldKey: omieSharedFieldKeySchema,
  vehicleId: z.string().nullable(),
};

/** Request body for resolving one open reconciliation by keeping CRM, Omie, or a manual value. */
export const pendingResolveBodySchema = z.discriminatedUnion("choice", [
  z.object({ ...pendingResolveBase, choice: z.literal("crm"), value: z.string().optional() }),
  z.object({ ...pendingResolveBase, choice: z.literal("omie"), value: z.string().optional() }),
  z.object({ ...pendingResolveBase, choice: z.literal("edit"), value: z.string() }),
]);

/** Response body for the customer linked to a conversation, including open reconciliation rows. */
export const conversationCustomerSchema = z.object({
  customer: customerSchema.nullable(),
  pendings: z.array(reconciliationPendingSchema),
});

/** Reconciliation row in the global pending queue, with customer display name for list UI. */
export const globalReconciliationPendingSchema = reconciliationPendingSchema.extend({
  customerName: z.string(),
});

/** One field a vehicle disagrees with the Omie on, carrying both sides. */
export const vehicleSyncConflictFieldSchema = z.object({
  fieldKey: omieSharedFieldKeySchema,
  crmValue: z.string(),
  omieValue: z.string(),
});

/**
 * Fields every variant of {@link vehicleOmieSyncSchema} carries.
 *
 * `mappingConfirmed` is `false` and nothing may set it true: the vehicle-to-Omie
 * field mapping is a guess until GitHub #29 closes, and a read model that let a
 * screen say "synchronised with the Omie" without that caveat would be claiming
 * a write nobody has validated against the real tenant.
 */
const vehicleSyncBase = {
  vehicleId: z.string(),
  mappingConfirmed: z.literal(false),
};

/**
 * A vehicle's synchronisation state with the Omie, rolled up from its
 * per-field `VehicleFieldSync` rows and its open `VehicleReconciliationPending`
 * rows into the one state a screen shows.
 *
 * The four states are ranked, conflict first (decided 2026-09-03): a vehicle
 * with both an open conflict and a failed attempt reads as `conflict`, because
 * a conflict is the one state that needs a person, and a failure the sync will
 * retry on its own must not hide it.
 */
export const vehicleOmieSyncSchema = z.discriminatedUnion("state", [
  z.object({
    ...vehicleSyncBase,
    state: z.literal("never_synced"),
    // Not merely absent: never-synchronised IS "this vehicle has no Omie id".
    omieId: z.null(),
  }),
  z.object({
    ...vehicleSyncBase,
    state: z.literal("synced"),
    omieId: z.string(),
    /** Most recent attempt across the vehicle's fields; null when no field has been pushed yet. */
    lastAttemptedAt: z.string().nullable(),
  }),
  z.object({
    ...vehicleSyncBase,
    state: z.literal("failed"),
    omieId: z.string().nullable(),
    lastAttemptedAt: z.string().nullable(),
    /** The field whose push failed, and why the Omie refused it. */
    fieldKey: omieSharedFieldKeySchema,
    reason: z.string().nullable(),
  }),
  z.object({
    ...vehicleSyncBase,
    state: z.literal("conflict"),
    omieId: z.string().nullable(),
    lastAttemptedAt: z.string().nullable(),
    /** Every field in conflict, each with both values, so no second request is needed. */
    fields: z.array(vehicleSyncConflictFieldSchema).min(1),
  }),
]);

/**
 * Rolls a vehicle's per-field sync rows and open pendings up into one state.
 *
 * Pure so the Prisma adapter and the memory fake cannot rank the states
 * differently; the ranking itself is documented on {@link vehicleOmieSyncSchema}.
 *
 * @param vehicle - The vehicle's id and its Omie id; a null `omieId` is what "never synchronised" means.
 * @param syncRows - That vehicle's `VehicleFieldSync` rows; an empty array means nothing has been pushed.
 * @param openPendings - That vehicle's OPEN reconciliation rows only; resolved ones must be filtered out by the caller, since a resolved conflict is history.
 * @returns Exactly one of the four states, always carrying `mappingConfirmed: false`.
 */
export function buildVehicleOmieSync(
  vehicle: { id: string; omieId: string | null },
  syncRows: {
    fieldKey: OmieSharedFieldKey;
    lastAttemptedAt: string | null;
    lastResult: string | null;
    lastError: string | null;
  }[],
  openPendings: { fieldKey: OmieSharedFieldKey; crmValue: string; omieValue: string }[],
): VehicleOmieSync {
  const attempts = syncRows
    .map((row) => row.lastAttemptedAt)
    .filter((at): at is string => at !== null);
  // ISO-8601 instants at the same offset compare lexicographically the same way
  // they compare in time, and these all come from `toISOString()`.
  const lastAttemptedAt = attempts.length === 0 ? null : attempts.reduce((a, b) => (a > b ? a : b));

  if (openPendings.length > 0) {
    return {
      vehicleId: vehicle.id,
      mappingConfirmed: false,
      state: "conflict",
      omieId: vehicle.omieId,
      lastAttemptedAt,
      fields: openPendings.map((pending) => ({
        fieldKey: pending.fieldKey,
        crmValue: pending.crmValue,
        omieValue: pending.omieValue,
      })),
    };
  }

  // The most recent failure, not the first one found: an older failure the sync
  // has since retried past would name a reason that no longer applies.
  const failures = syncRows.filter((row) => row.lastResult === "failed");
  const latestFailure = failures.reduce<(typeof failures)[number] | null>((best, row) => {
    if (best === null) {
      return row;
    }
    if (row.lastAttemptedAt === null) {
      return best;
    }
    if (best.lastAttemptedAt === null) {
      return row;
    }
    return row.lastAttemptedAt > best.lastAttemptedAt ? row : best;
  }, null);
  if (latestFailure !== null) {
    return {
      vehicleId: vehicle.id,
      mappingConfirmed: false,
      state: "failed",
      omieId: vehicle.omieId,
      lastAttemptedAt,
      fieldKey: latestFailure.fieldKey,
      reason: latestFailure.lastError,
    };
  }

  if (vehicle.omieId !== null) {
    return {
      vehicleId: vehicle.id,
      mappingConfirmed: false,
      state: "synced",
      omieId: vehicle.omieId,
      lastAttemptedAt,
    };
  }

  return {
    vehicleId: vehicle.id,
    mappingConfirmed: false,
    state: "never_synced",
    omieId: null,
  };
}

/** One field a vehicle disagrees with the Omie on, with both values. */
export type VehicleSyncConflictField = z.infer<typeof vehicleSyncConflictFieldSchema>;

/** A vehicle's Omie synchronisation state: never synced, synced, failed, or in conflict. */
export type VehicleOmieSync = z.infer<typeof vehicleOmieSyncSchema>;

/** Request body for patching customer or vehicle fields from the conversation rail. */
export type CustomerFieldEdit = z.infer<typeof customerFieldEditSchema>;

/** Open reconciliation row comparing CRM and Omie values for one shared field. */
export type ReconciliationPending = z.infer<typeof reconciliationPendingSchema>;

/** Request body for resolving one open reconciliation by keeping CRM, Omie, or a manual value. */
export type PendingResolveBody = z.infer<typeof pendingResolveBodySchema>;

/** Customer linked to a conversation, including open reconciliation rows. */
export type ConversationCustomer = z.infer<typeof conversationCustomerSchema>;

/** Reconciliation row in the global pending queue, with customer display name for list UI. */
export type GlobalReconciliationPending = z.infer<typeof globalReconciliationPendingSchema>;
