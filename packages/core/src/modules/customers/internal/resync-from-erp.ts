/**
 * `resync-from-erp`: refreshes a linked customer from the ERP before a read.
 *
 * Moved from `apps/api/src/http/cadastro-link.ts` (`refreshLinkedCustomer`) with the
 * body unchanged (4B; the dispatch called it resync-vehicle-from-erp, and it is
 * internal because no route is its own). `GET /conversations/:id/customer` and
 * `GET /conversations/:id/vehicles` call it. The ERP call (`ingestOmieSnapshot`
 * reads the Omie snapshot) runs outside any transaction; each store call it makes is
 * its own `customers` transaction (W2-C12). A failure keeps the stored customer.
 */
import { ingestOmieSnapshot } from "../contracts/cadastro-engine/index.js";
import type { CadastroStore, CustomerRecord } from "../contracts/cadastro-store/port.js";
import type { OmieAdapter } from "../../../kernel/clients/erp-mock.js";

/**
 * Refreshes a linked customer from Omie before the cadastro rail responds.
 *
 * Unlinked customers (`omieId` null) are returned as stored with no Omie call.
 * A failed or unavailable Omie read returns the stored record and does not throw.
 *
 * @param cadastro - Customer persistence used by `ingestOmieSnapshot`.
 * @param adapter - Omie read adapter; `get` is skipped when `customer.omieId` is null.
 * @param customer - Resolved conversation customer, or `null` when none is linked.
 * @returns The customer after ingest, or the stored/`null` input on skip or failure.
 */
export async function refreshLinkedCustomer(
  cadastro: CadastroStore,
  adapter: OmieAdapter,
  customer: CustomerRecord | null,
): Promise<CustomerRecord | null> {
  if (!customer?.omieId) {
    return customer;
  }
  try {
    await ingestOmieSnapshot(cadastro, adapter, customer.id);
    return (await cadastro.getCustomer(customer.id)) ?? customer;
  } catch {
    return customer;
  }
}
