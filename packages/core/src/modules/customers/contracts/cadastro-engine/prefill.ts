/**
 * `persistPrefillAccept`: write one accepted AI prefill value — a full sync when linked, a local bump when not.
 *
 * Moved from `packages/omie/src/engine.ts` (wave 5.1b) with bodies unchanged.
 */
import type { CustomerFieldEdit } from "../http.omie-sync.js";
import type { OmieSharedFieldKey } from "../../../../shared/web/omie-field-keys.js";
import type { PrefillFieldKey } from "../../../prefill/contracts/http.js";
import { isVehicleField, type OmieAdapter } from "../../../../kernel/clients/erp-mock.js";
import type { CadastroStore } from "../cadastro-store/port.js";
import { applyCrmEdit } from "./apply-crm-edit.js";
import type { ApplyCrmEditResult } from "./results.js";
import { setBusinessValue } from "./values.js";

const PREFILL_SHARED_KEYS = ["name", "taxId", "plate", "make", "model", "odometerKm"] as const;

/**
 * Persists an accepted AI prefill value — full sync when linked, local-only bump when the customer has no Omie id yet.
 *
 * @param store - Cadastro persistence port.
 * @param adapter - Omie read/write port when the customer is linked.
 * @param input.customerId - CRM customer receiving the prefill.
 * @param input.unitId - Caller unit id; must match the customer's `unitId`.
 * @param input.field - Prefill field key (`version`/`year` are CRM-only on the titular vehicle).
 * @param input.value - Accepted prefill value as string or number.
 * @param input.actorId - Optional actor id forwarded to `applyCrmEdit`.
 * @returns `applyCrmEdit` outcomes when linked; `ok` with local bump when unlinked; `not_found` for missing titular or unsupported field.
 */
export async function persistPrefillAccept(
  store: CadastroStore,
  adapter: OmieAdapter,
  input: {
    customerId: string;
    unitId: string;
    field: PrefillFieldKey;
    value: string | number;
    actorId?: string;
  },
): Promise<ApplyCrmEditResult> {
  const customer = await store.getCustomer(input.customerId);
  if (!customer) {
    return { status: "not_found" };
  }
  if (customer.unitId !== input.unitId) {
    return { status: "unit_mismatch" };
  }
  const vehicle = await store.getVehicleForCustomer(customer.id);
  if (input.field === "version" || input.field === "year") {
    if (!vehicle) {
      return { status: "not_found" };
    }
    if (input.field === "version") {
      vehicle.version = String(input.value);
    } else {
      vehicle.year = Number(input.value);
    }
    await store.saveVehicle(vehicle);
    return { status: "ok", customer };
  }
  if (customer.omieId) {
    return applyCrmEdit(store, adapter, {
      customerId: customer.id,
      unitId: input.unitId,
      patch: { [input.field]: input.value } as CustomerFieldEdit,
      actorId: input.actorId,
    });
  }
  const fieldKey = input.field as OmieSharedFieldKey;
  if (!PREFILL_SHARED_KEYS.includes(input.field as (typeof PREFILL_SHARED_KEYS)[number])) {
    return { status: "not_found" };
  }
  if (isVehicleField(fieldKey) && !vehicle) {
    return { status: "not_found" };
  }
  setBusinessValue(customer, vehicle, fieldKey, input.value);
  await store.saveCustomer(customer);
  if (vehicle) {
    await store.saveVehicle(vehicle);
  }
  const owner = isVehicleField(fieldKey) && vehicle ? { vehicleId: vehicle.id } : { customerId: customer.id };
  await store.bumpLocal(owner, fieldKey, input.actorId ?? null);
  return { status: "ok", customer };
}
