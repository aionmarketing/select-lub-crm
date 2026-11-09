/**
 * What prefill's routes need from outside the database: the Omie adapter,
 * handed to `customers`' `applyPrefillSuggestion` when a field is accepted.
 *
 * It pushes to Omie synchronously, a provider call, so the accept routes call
 * it OUTSIDE any `db.tx` of their own.
 */
import type { OmieAdapter } from "../../../kernel/clients/erp-mock.js";

/** The ports prefill's routes are built over. */
export interface PrefillPorts {
  readonly omieAdapter: OmieAdapter;
}
