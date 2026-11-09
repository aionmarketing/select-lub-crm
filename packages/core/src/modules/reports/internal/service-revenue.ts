/**
 * Which services count as revenue, and how much. A service is Omie-origin when
 * it carries an Omie id and did not originate in the CRM; its amount counts as
 * zero when unrecorded.
 *
 * Moved from the top of `apps/api/src/reports/insights.ts`, unchanged except
 * for the `export`s: the period insights and the customer figures both read it,
 * and they now live in separate files.
 */
import type { AttributionServiceRow } from "./attribution.js";

/** True for a service that came from Omie rather than being created in the CRM. */
export function isOmieOrigin(service: AttributionServiceRow) {
  return service.omieId !== null && service.origin !== "crm";
}

/** The service's recorded amount, or zero when none was recorded. */
export function amountOf(service: AttributionServiceRow) {
  return service.amount ?? 0;
}
