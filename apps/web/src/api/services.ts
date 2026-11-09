/**
 * Service-order HTTP.
 */
import {
  conversationServicesSchema,
  serviceDetailSchema,
  serviceListSchema,
  unitServicePageSchema,
  type ConversationServices,
  type Service,
  type ServiceDetail,
  type UnitServicePage,
  type UnitServiceQuery,
} from "@select-lub/shared-types";
import { apiBase, apiRead, parse } from "./http.js";

/**
 * Lists service orders for the conversation's linked customer.
 * @param conversationId - CRM conversation id used in the path segment.
 * @returns Parsed `ConversationServices` from `GET /conversations/:conversationId/services`; `customerId` is null when no cadastro is linked.
 */
export async function fetchConversationServices(
  conversationId: string,
): Promise<ConversationServices> {
  const body = await parse(
    await apiRead(`${apiBase}/conversations/${conversationId}/services`),
  );
  return conversationServicesSchema.parse(body);
}

/**
 * Lists services for one vehicle in the current unit.
 * @param vehicleId - CRM vehicle id used in the path segment.
 * @returns Parsed `Service[]` from `GET /vehicles/:vehicleId/services`.
 */
export async function fetchVehicleServices(vehicleId: string): Promise<Service[]> {
  const body = await parse(await apiRead(`${apiBase}/vehicles/${vehicleId}/services`));
  return serviceListSchema.parse(body);
}

/**
 * Lists one page of all customers' services for the current unit (Serviços screen).
 *
 * @param query - Period bound, search term, page size, and continuation; every field optional. An empty query means unbounded, unsearched, first page.
 * @returns Parsed page from `GET /services`: the rows, whether more match, and the cursor for the next page.
 */
export async function fetchUnitServices(query: UnitServiceQuery = {}): Promise<UnitServicePage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  const suffix = params.size === 0 ? "" : `?${params.toString()}`;
  const body = await parse(await apiRead(`${apiBase}/services${suffix}`));
  return unitServicePageSchema.parse(body);
}

/**
 * Reads one service in full for the Serviços detail region.
 *
 * @param serviceId - CRM service id used in the path segment.
 * @returns Parsed `ServiceDetail` from `GET /services/:serviceId`: the row, its attributed quote, and that vehicle's other services.
 */
export async function fetchServiceDetail(serviceId: string): Promise<ServiceDetail> {
  const body = await parse(await apiRead(`${apiBase}/services/${serviceId}`));
  return serviceDetailSchema.parse(body);
}
