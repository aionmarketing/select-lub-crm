/**
 * `customers/vehicle-changed` — an attendant created a vehicle or edited its fields.
 *
 * Published after the CRM write by `PATCH /vehicles/:id` and the two vehicle-create
 * routes (`POST /customers/:id/vehicles`, `POST /conversations/:id/vehicles`),
 * whether or not the synchronous push to Omie succeeded.
 *
 * NO SUBSCRIBER YET, for the same reason as `customer-changed` (4B ruling Q1a): the
 * write-back stays synchronous in this move.
 */
import { z } from "zod";
import { defineEvent } from "../../../kernel/events.js";

/** What changed, where, and who changed it. */
export const vehicleChangedSchema = z.object({
  vehicleId: z.string().min(1),
  customerId: z.string().min(1),
  unitId: z.string().min(1),
  /** The vehicle fields the request carried; on a create, the ones it set. */
  fields: z.array(z.string().min(1)),
  actorId: z.string().nullable(),
  /** `true` for a create, `false` for an edit. */
  created: z.boolean(),
});

/** The payload of {@link vehicleChanged}. */
export type VehicleChanged = z.infer<typeof vehicleChangedSchema>;

/** Published by the vehicle-create and vehicle-edit slices. */
export const vehicleChanged = defineEvent<VehicleChanged>(
  "customers/vehicle-changed",
  vehicleChangedSchema,
);
