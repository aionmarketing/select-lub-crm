/**
 * Cadastro HTTP: conversation customer/vehicles, customer/vehicle patches, pendings.
 */
import {
  conversationCustomerSchema,
  conversationVehiclesSchema,
  customerSchema,
  globalReconciliationPendingSchema,
  invalidPlateErrorSchema,
  plateLookupResponseSchema,
  vehicleSchema,
  type ConversationCustomer,
  type ConversationVehicles,
  type Customer,
  type CustomerFieldEdit,
  type GlobalReconciliationPending,
  type PendingResolveBody,
  type PlateLookupResponse,
  type Vehicle,
  type VehicleCreateBody,
  type VehicleFieldEdit,
} from "@select-lub/shared-types";
import { apiBase, apiRead, headers, parse } from "./http.js";

/**
 * Parses a cadastro write that may return the saved row with HTTP 503 when Omie is down.
 * @param response - Fetch response from PATCH customer, POST conversation customer, or pending resolve.
 * @returns Parsed customer plus `omieUnavailable` when the status is 503.
 * @throws When the status is not 2xx or 503.
 */
async function parseCadastroWrite(
  response: Response,
): Promise<{ customer: Customer; omieUnavailable: boolean }> {
  if (response.status === 503) {
    return { customer: customerSchema.parse(await response.json()), omieUnavailable: true };
  }
  if (!response.ok) {
    throw new Error(`http ${response.status}`);
  }
  return { customer: customerSchema.parse(await response.json()), omieUnavailable: false };
}

export async function fetchConversationVehicles(
  conversationId: string,
): Promise<ConversationVehicles> {
  const body = await parse(
    await apiRead(`${apiBase}/conversations/${conversationId}/vehicles`),
  );
  return conversationVehiclesSchema.parse(body);
}

/**
 * Registers a new vehicle on the conversation customer.
 * @param conversationId - CRM conversation id used in the path segment.
 * @param input - Optional plate and vehicle fields; empty object creates a blank vehicle row.
 * @returns Parsed `Vehicle` from `POST /conversations/:conversationId/vehicles`.
 */
export async function addConversationVehicle(
  conversationId: string,
  input: VehicleCreateBody = {},
): Promise<Vehicle> {
  const body = await parse(
    await fetch(`${apiBase}/conversations/${conversationId}/vehicles`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return vehicleSchema.parse(body);
}

/**
 * Loads the customer linked to a conversation, including open Omie reconciliation rows.
 * @param conversationId - CRM conversation id used in the path segment.
 * @returns Parsed `{ customer, pendings }` from `GET /conversations/:conversationId/customer`; `customer` is null when none is linked.
 */
export async function fetchConversationCustomer(
  conversationId: string,
): Promise<ConversationCustomer> {
  const body = await parse(
    await apiRead(`${apiBase}/conversations/${conversationId}/customer`),
  );
  return conversationCustomerSchema.parse(body);
}

/**
 * Creates and links a Cliente for a conversation that has none yet, then applies the form patch.
 * @param conversationId - CRM conversation id used in the path segment.
 * @param patch - Cadastro fields from the rail form; `name` is the usual create key.
 * @returns Saved customer and whether Omie returned unavailable (HTTP 503 with the local row).
 */
export async function createConversationCustomer(
  conversationId: string,
  patch: CustomerFieldEdit,
): Promise<{ customer: Customer; omieUnavailable: boolean }> {
  return parseCadastroWrite(
    await fetch(`${apiBase}/conversations/${conversationId}/customer`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

/**
 * Patches displayed cadastro fields on an existing customer.
 * @param customerId - CRM customer id used in the path segment.
 * @param patch - Partial person/address fields from the rail form.
 * @returns Saved customer and whether Omie returned unavailable (HTTP 503 with the local row).
 */
export async function patchCustomer(
  customerId: string,
  patch: CustomerFieldEdit,
): Promise<{ customer: Customer; omieUnavailable: boolean }> {
  return parseCadastroWrite(
    await fetch(`${apiBase}/customers/${customerId}`, {
      method: "PATCH",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

/**
 * Resolves one open Omie reconciliation pending for a customer.
 * @param customerId - CRM customer id used in the path segment.
 * @param body - Choice (`crm` / `omie` / `edit`) plus field key and optional typed value.
 * @returns Saved customer and whether Omie returned unavailable (HTTP 503 with the local row).
 */
export async function resolveCustomerPending(
  customerId: string,
  body: PendingResolveBody,
): Promise<{ customer: Customer; omieUnavailable: boolean }> {
  return parseCadastroWrite(
    await fetch(`${apiBase}/customers/${customerId}/reconciliation-pendings/resolve`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * Lists open Omie reconciliation pendings across every customer in the current unit.
 * @returns Parsed global pending rows from `GET /reconciliation-pendings`.
 */
export async function fetchGlobalPendings(): Promise<GlobalReconciliationPending[]> {
  const body = await parse(await apiRead(`${apiBase}/reconciliation-pendings`));
  return globalReconciliationPendingSchema.array().parse(body);
}

/**
 * Patches identity fields on one listed vehicle.
 * @param vehicleId - CRM vehicle id used in the path segment.
 * @param patch - Partial vehicle fields from the rail row form.
 * @returns Saved vehicle and whether Omie returned unavailable (HTTP 503 with the local row).
 */
export async function patchVehicle(
  vehicleId: string,
  patch: VehicleFieldEdit,
): Promise<{ vehicle: Vehicle; omieUnavailable: boolean }> {
  const response = await fetch(`${apiBase}/vehicles/${vehicleId}`, {
    method: "PATCH",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (response.status === 503) {
    return { vehicle: vehicleSchema.parse(await response.json()), omieUnavailable: true };
  }
  if (!response.ok) {
    throw new Error(`http ${response.status}`);
  }
  return { vehicle: vehicleSchema.parse(await response.json()), omieUnavailable: false };
}

/**
 * Looks up cadastro suggestions for a plate. Does not write a vehicle row.
 *
 * @param plate - Raw plate text; the API normalizes and rejects malformed input with 422.
 * @param options.retry - When true, a stored miss is billed again.
 * @returns Discriminated lookup response (`found` / `not_found` / `failed` / `unavailable`).
 * @throws Error `http <status>` for unexpected statuses; `invalid_plate` for HTTP 422.
 */
export async function lookupPlate(
  plate: string,
  options?: { retry?: boolean },
): Promise<PlateLookupResponse> {
  const response = await fetch(`${apiBase}/plate-lookups`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({ plate, ...(options?.retry ? { retry: true } : {}) }),
  });
  if (response.status === 422) {
    invalidPlateErrorSchema.parse(await response.json());
    throw new Error("invalid_plate");
  }
  if (!response.ok) {
    throw new Error(`http ${response.status}`);
  }
  return plateLookupResponseSchema.parse(await response.json());
}
