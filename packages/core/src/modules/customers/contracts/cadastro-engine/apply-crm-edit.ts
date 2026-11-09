/**
 * `applyCrmEdit`: an attendant's customer edit — save, bump the local versions, and push to Omie synchronously when linked.
 *
 * Moved from `packages/omie/src/engine.ts` (wave 5.1b) with bodies unchanged.
 */
import type { CustomerFieldEdit } from "../http.omie-sync.js";
import { CRM_ONLY_KEYS, isVehicleField, SHARED_FIELD_KEYS, type OmieAdapter, type CrmFieldValue } from "../../../../kernel/clients/erp-mock.js";
import type { CadastroStore } from "../cadastro-store/port.js";
import { decideField } from "./decide-field.js";
import type { ApplyCrmEditResult } from "./results.js";
import { syncOwner, setBusinessValue } from "./values.js";

/**
 * Applies a customer patch, bumps local sync versions, and pushes or reconciles shared fields with Omie when linked.
 *
 * @param store - Cadastro persistence port.
 * @param adapter - Omie read/write port.
 * @param input.customerId - CRM customer to edit.
 * @param input.unitId - Caller unit id; must match the customer's `unitId`.
 * @param input.patch - Customer field edit; shared keys trigger sync; CRM-only keys save locally only.
 * @param input.actorId - Optional actor id recorded on sync bumps.
 * @returns `ok` with saved customer, `not_found`, `unit_mismatch`, or `omie_unavailable` when Omie throws after the CRM save.
 */
export async function applyCrmEdit(
  store: CadastroStore,
  adapter: OmieAdapter,
  input: { customerId: string; unitId: string; patch: CustomerFieldEdit; actorId?: string },
): Promise<ApplyCrmEditResult> {
  const customer = await store.getCustomer(input.customerId);
  if (!customer) {
    return { status: "not_found" };
  }
  if (customer.unitId !== input.unitId) {
    return { status: "unit_mismatch" };
  }

  const vehicle = await store.getVehicleForCustomer(customer.id);
  const sharedKeys = SHARED_FIELD_KEYS.filter((key) => Object.hasOwn(input.patch, key));
  if (sharedKeys.some((key) => isVehicleField(key)) && !vehicle) {
    return { status: "not_found" };
  }

  for (const key of CRM_ONLY_KEYS) {
    if (!Object.hasOwn(input.patch, key)) {
      continue;
    }
    const value = input.patch[key] ?? null;
    if (key === "givenName") {
      customer.givenName = value;
    } else if (key === "familyName") {
      customer.familyName = value;
    } else {
      customer.mergedIntoId = value;
    }
  }

  for (const key of sharedKeys) {
    const value = input.patch[key] as CrmFieldValue;
    setBusinessValue(customer, vehicle, key, value);
    const owner = syncOwner(customer.id, vehicle, key);
    if (!owner) {
      continue;
    }
    await store.bumpLocal(owner, key, input.actorId ?? null);
  }

  await store.saveCustomer(customer);
  if (vehicle) {
    await store.saveVehicle(vehicle);
  }

  try {
    const snapshot = customer.omieId ? await adapter.get(customer.omieId) : null;
    for (const key of sharedKeys) {
      await decideField({
        store,
        adapter,
        customer,
        vehicle,
        fieldKey: key,
        snapshot,
        actorId: input.actorId,
      });
    }
  } catch {
    const savedAfterFail = await store.getCustomer(customer.id);
    if (!savedAfterFail) {
      return { status: "not_found" };
    }
    return { status: "omie_unavailable", customer: savedAfterFail };
  }

  const saved = await store.getCustomer(customer.id);
  if (!saved) {
    return { status: "not_found" };
  }
  return { status: "ok", customer: saved };
}

export async function savedCustomerOrMissing(
  store: CadastroStore,
  customerId: string,
): Promise<ApplyCrmEditResult> {
  const saved = await store.getCustomer(customerId);
  if (!saved) {
    return { status: "not_found" };
  }
  return { status: "ok", customer: saved };
}
