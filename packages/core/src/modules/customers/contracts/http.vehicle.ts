/**
 * Zod contracts for customer vehicles and conversation-scoped vehicle lists.
 *
 * Moved from `packages/shared-types/src/vehicle.ts` (5.1d) with declarations unchanged.
 */
import { z } from "zod";
import { plateSourcedFieldKeySchema } from "../../plate-lookup/contracts/http.js";

/**
 * A Veículo's background oil research flag (background-oil-research D18): present only while
 * its identity's research is running, waiting for a manual, or queued with someone waiting on
 * it, and research is not stopped.
 */
export const vehicleOilResearchSchema = z.object({ status: z.literal("researching") });

/** Response body for a vehicle row linked to a customer. */
export const vehicleSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  omieId: z.string().nullable(),
  plate: z.string().nullable(),
  make: z.string().nullable(),
  model: z.string().nullable(),
  version: z.string().nullable(),
  year: z.number().int().nullable(),
  odometerKm: z.number().nullable(),
  origin: z.string().trim().min(1),
  plateSourcedKeys: z.array(plateSourcedFieldKeySchema).default([]),
  /**
   * An `oilResearch` whose status this bundle does not know reads as absent, so a status added
   * later never fails a whole vehicle list (D18).
   */
  oilResearch: vehicleOilResearchSchema.optional().catch(undefined),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const nullableString = z.string().nullable();

/** Request body for `POST` to create a vehicle on a customer. */
export const vehicleCreateBodySchema = z.object({
  plate: nullableString.optional(),
  make: nullableString.optional(),
  model: nullableString.optional(),
  version: nullableString.optional(),
  year: z.number().int().nullable().optional(),
  odometerKm: z.number().nullable().optional(),
  plateSourcedKeys: z.array(plateSourcedFieldKeySchema).optional(),
});

/** Request body for patching vehicle fields from the conversation rail or Omie reconciliation. */
export const vehicleFieldEditSchema = z.object({
  plate: nullableString.optional(),
  make: nullableString.optional(),
  model: nullableString.optional(),
  version: nullableString.optional(),
  year: z.number().int().nullable().optional(),
  odometerKm: z.number().nullable().optional(),
  plateSourcedKeys: z.array(plateSourcedFieldKeySchema).optional(),
});

/** Response body for vehicles resolved from a conversation's linked customer. */
export const conversationVehiclesSchema = z.object({
  customerId: z.string().nullable(),
  vehicles: z.array(vehicleSchema),
});

/** Response body for a flat list of vehicles. */
export const vehicleListSchema = z.array(vehicleSchema);

/** Vehicle row linked to a customer. */
export type Vehicle = z.infer<typeof vehicleSchema>;

/** Request body for `POST` to create a vehicle on a customer. */
export type VehicleCreateBody = z.infer<typeof vehicleCreateBodySchema>;

/** Request body for patching vehicle fields from the conversation rail or Omie reconciliation. */
export type VehicleFieldEdit = z.infer<typeof vehicleFieldEditSchema>;

/** Vehicles resolved from a conversation's linked customer. */
export type ConversationVehicles = z.infer<typeof conversationVehiclesSchema>;
