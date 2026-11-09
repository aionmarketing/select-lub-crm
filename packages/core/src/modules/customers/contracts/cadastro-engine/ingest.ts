/**
 * `ingestOmieSnapshot`: read a linked customer's Omie snapshot and decide every shared field against it.
 *
 * Moved from `packages/omie/src/engine.ts` (wave 5.1b) with bodies unchanged.
 */
import { SHARED_FIELD_KEYS, readSnapshotField, type OmieAdapter } from "../../../../kernel/clients/erp-mock.js";
import type { CadastroStore } from "../cadastro-store/port.js";
import { loadSync, decideField } from "./decide-field.js";
import { syncOwner } from "./values.js";

/**
 * Compares a fresh Omie snapshot against stored sync state and applies inbound changes or opens pendings.
 *
 * @param store - Cadastro persistence port.
 * @param adapter - Omie read port used to fetch the latest snapshot.
 * @param customerId - CRM customer linked to Omie; no-op when missing or unlinked.
 * @returns Resolves when every shared field has been decided; no-op when customer has no `omieId` or Omie returns null.
 */
export async function ingestOmieSnapshot(
  store: CadastroStore,
  adapter: OmieAdapter,
  customerId: string,
): Promise<void> {
  const customer = await store.getCustomer(customerId);
  if (!customer?.omieId) {
    return;
  }
  const snapshot = await adapter.get(customer.omieId);
  if (!snapshot) {
    return;
  }
  const vehicle = await store.getVehicleForCustomer(customer.id);

  for (const fieldKey of SHARED_FIELD_KEYS) {
    const owner = syncOwner(customer.id, vehicle, fieldKey);
    if (!owner) {
      continue;
    }
    const read = readSnapshotField(snapshot, fieldKey);
    if (read.status === "skip") {
      continue;
    }
    const sync = await loadSync(store, owner, fieldKey);
    const previousWire = sync.lastOmieWire ?? "";
    if (read.wire !== previousWire) {
      await store.bumpExternal(owner, fieldKey, read.wire);
    }
    await decideField({ store, adapter, customer, vehicle, fieldKey, snapshot });
  }
}
