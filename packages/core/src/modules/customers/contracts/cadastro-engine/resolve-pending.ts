/**
 * `resolvePending`: close an open conflict with the CRM value, the Omie value, or a manual one, and sync the winner.
 *
 * Moved from `packages/omie/src/engine.ts` (wave 5.1b) with bodies unchanged.
 */
import type { OmieSharedFieldKey } from "../../../../shared/web/omie-field-keys.js";
import { isVehicleField, toWire, type OmieAdapter } from "../../../../kernel/clients/erp-mock.js";
import type { CadastroStore } from "../cadastro-store/port.js";
import { savedCustomerOrMissing } from "./apply-crm-edit.js";
import { loadSync } from "./decide-field.js";
import type { ApplyCrmEditResult } from "./results.js";
import { syncOwner, getBusinessValue, setBusinessValue, parseStoredValue } from "./values.js";

/**
 * Resolves an open field conflict by choosing CRM, Omie, or a manual value and syncing the winner to Omie when linked.
 *
 * @param store - Cadastro persistence port.
 * @param adapter - Omie write port when pushing the winning CRM value.
 * @param input.customerId - CRM customer owning the pending.
 * @param input.unitId - Caller unit id; must match the customer's `unitId`.
 * @param input.fieldKey - Shared field in conflict.
 * @param input.vehicleId - Titular vehicle id for vehicle fields; must be `null` for person fields.
 * @param input.choice - `"crm"` keeps CRM value, `"omie"` applies stored Omie value, `"edit"` applies `input.value`.
 * @param input.value - Required when `choice` is `"edit"`; string form of the manual CRM value.
 * @param input.actorId - CRM user resolving the pending.
 * @returns Same status union as `applyCrmEdit`; `omie_unavailable` when Omie rejects or throws on push.
 * @throws `Error("pending_not_found")` when owner/vehicle pairing is wrong, pending is missing, or `edit` lacks `value`.
 */
export async function resolvePending(
  store: CadastroStore,
  adapter: OmieAdapter,
  input: {
    customerId: string;
    unitId: string;
    fieldKey: OmieSharedFieldKey;
    vehicleId: string | null;
    choice: "crm" | "omie" | "edit";
    value?: string;
    actorId: string;
  },
): Promise<ApplyCrmEditResult> {
  const customer = await store.getCustomer(input.customerId);
  if (!customer) {
    return { status: "not_found" };
  }
  if (customer.unitId !== input.unitId) {
    return { status: "unit_mismatch" };
  }

  const vehicleField = isVehicleField(input.fieldKey);
  if (vehicleField ? input.vehicleId === null : input.vehicleId !== null) {
    throw new Error("pending_not_found");
  }

  const titular = await store.getVehicleForCustomer(customer.id);
  const vehicle = vehicleField
    ? input.vehicleId
      ? await store.getVehicle(input.vehicleId)
      : null
    : titular;
  if (vehicleField && (!vehicle || vehicle.customerId !== customer.id)) {
    throw new Error("pending_not_found");
  }

  const owner = syncOwner(customer.id, vehicle, input.fieldKey);
  if (!owner) {
    throw new Error("pending_not_found");
  }
  const pending = await store.getOpenPending(owner, input.fieldKey);
  if (!pending) {
    throw new Error("pending_not_found");
  }

  if (input.choice === "omie") {
    setBusinessValue(customer, vehicle, input.fieldKey, parseStoredValue(input.fieldKey, pending.omieValue));
    await store.saveCustomer(customer);
    if (vehicle) {
      await store.saveVehicle(vehicle);
    }
    const sync = await loadSync(store, owner, input.fieldKey);
    await store.markSynced(
      owner,
      input.fieldKey,
      { localVersion: sync.localVersion, externalVersion: sync.externalVersion },
      { origin: "OMIE_SYNC", changedBy: input.actorId },
    );
    await store.closeOpenPending(owner, input.fieldKey, input.actorId);
    return savedCustomerOrMissing(store, customer.id);
  }

  if (input.choice === "edit") {
    if (input.value === undefined) {
      throw new Error("pending_not_found");
    }
    setBusinessValue(customer, vehicle, input.fieldKey, parseStoredValue(input.fieldKey, input.value));
    await store.bumpLocal(owner, input.fieldKey, input.actorId);
    await store.saveCustomer(customer);
    if (vehicle) {
      await store.saveVehicle(vehicle);
    }
  }

  if (customer.omieId) {
    const crmValue = getBusinessValue(customer, vehicle, input.fieldKey);
    try {
      const put = await adapter.put(customer.omieId, { [input.fieldKey]: crmValue }, customer.id);
      if (put.failedKeys.includes(input.fieldKey)) {
        const savedAfterFail = await store.getCustomer(customer.id);
        if (!savedAfterFail) {
          return { status: "not_found" };
        }
        return { status: "omie_unavailable", customer: savedAfterFail };
      }
    } catch {
      const savedAfterFail = await store.getCustomer(customer.id);
      if (!savedAfterFail) {
        return { status: "not_found" };
      }
      return { status: "omie_unavailable", customer: savedAfterFail };
    }
    const sync = await loadSync(store, owner, input.fieldKey);
    const mapped = toWire(input.fieldKey, crmValue);
    await store.markSynced(
      owner,
      input.fieldKey,
      { localVersion: sync.localVersion, externalVersion: sync.externalVersion },
      {
        origin: "CRM",
        lastOmieWire: mapped.ok ? mapped.wire : undefined,
        changedBy: input.actorId,
      },
    );
  }

  await store.closeOpenPending(owner, input.fieldKey, input.actorId);
  return savedCustomerOrMissing(store, customer.id);
}
