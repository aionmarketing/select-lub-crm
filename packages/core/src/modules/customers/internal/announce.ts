/**
 * Publishes `customers/customer-changed` and `customers/vehicle-changed` after the
 * CRM write of an edit or create, whether or not the synchronous Omie push
 * succeeded. No subscriber yet (4B ruling Q1a); see the two contracts.
 */
import { publish } from "../../../kernel/events.js";
import { customerChanged, type CustomerChanged } from "../contracts/customer-changed.js";
import { vehicleChanged, type VehicleChanged } from "../contracts/vehicle-changed.js";

/**
 * Announces a customer edit. An edit that carried no field (an empty PATCH body)
 * changed nothing, and announces nothing.
 *
 * @param change - The customer, the unit, the fields, the actor and the kind of edit.
 */
export async function announceCustomerChange(change: CustomerChanged): Promise<void> {
  if (change.fields.length === 0) return;
  await publish(customerChanged, change);
}

/**
 * Announces a vehicle create or edit.
 *
 * @param change - The vehicle, its customer, the unit, the fields, the actor, and whether it was created.
 */
export async function announceVehicleChange(change: VehicleChanged): Promise<void> {
  await publish(vehicleChanged, change);
}
