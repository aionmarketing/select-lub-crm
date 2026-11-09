/**
 * `decideField`: for one shared field, push a CRM-ahead value, apply an Omie-ahead one, or open a pending when both moved.
 *
 * Moved from `packages/omie/src/engine.ts` (wave 5.1b) with bodies unchanged.
 */
import type { OmieSharedFieldKey } from "../../../../shared/web/omie-field-keys.js";
import { isVehicleField, readSnapshotField, stringifyCrmValue, toWire, type OmieAdapter, type OmieClientSnapshot } from "../../../../kernel/clients/erp-mock.js";
import { emptySync, type CadastroStore, type CustomerRecord, type FieldSyncRow, type SyncOwner, type VehicleRecord } from "../cadastro-store/port.js";
import { syncOwner, getBusinessValue, setBusinessValue } from "./values.js";

export async function loadSync(
  store: CadastroStore,
  owner: SyncOwner,
  fieldKey: OmieSharedFieldKey,
): Promise<FieldSyncRow> {
  return (await store.getSync(owner, fieldKey)) ?? emptySync(fieldKey);
}

export async function decideField(input: {
  store: CadastroStore;
  adapter: OmieAdapter;
  customer: CustomerRecord;
  vehicle: VehicleRecord | null;
  fieldKey: OmieSharedFieldKey;
  snapshot: OmieClientSnapshot | null;
  actorId?: string;
}): Promise<void> {
  const { store, adapter, customer, vehicle, fieldKey, snapshot } = input;
  const owner = syncOwner(customer.id, vehicle, fieldKey);
  if (!owner) {
    return;
  }
  const omieId = customer.omieId;
  if (!omieId) {
    return;
  }
  const pending = await store.getOpenPending(owner, fieldKey);
  const sync = await loadSync(store, owner, fieldKey);
  const crmAhead = sync.localVersion > sync.syncedLocalVersion;
  const omieAhead = sync.externalVersion > sync.syncedExternalVersion;

  if (pending) {
    return;
  }

  if (crmAhead && omieAhead) {
    const omieRead = snapshot ? readSnapshotField(snapshot, fieldKey) : { status: "skip" as const };
    await store.saveOpenPending({
      fieldKey,
      crmValue: stringifyCrmValue(getBusinessValue(customer, vehicle, fieldKey)),
      omieValue:
        omieRead.status === "value" ? stringifyCrmValue(omieRead.crm) : "",
      localVersion: sync.localVersion,
      externalVersion: sync.externalVersion,
      status: "open",
      customerId: customer.id,
      vehicleId: isVehicleField(fieldKey) && vehicle ? vehicle.id : null,
    });
    return;
  }

  if (crmAhead && !omieAhead) {
    const crmValue = getBusinessValue(customer, vehicle, fieldKey);
    const mapped = toWire(fieldKey, crmValue);
    if (!mapped.ok) {
      await store.recordAttempt(owner, fieldKey, { result: "failed", error: "wire_mapping_failed" });
      return;
    }
    const put = await adapter.put(omieId, { [fieldKey]: crmValue }, customer.id);
    if (put.failedKeys.includes(fieldKey)) {
      await store.recordAttempt(owner, fieldKey, {
        result: "failed",
        error: put.reasons?.[fieldKey] ?? "omie_put_rejected",
      });
      return;
    }
    await store.recordAttempt(owner, fieldKey, { result: "ok", error: null });
    await store.markSynced(
      owner,
      fieldKey,
      { localVersion: sync.localVersion, externalVersion: sync.externalVersion },
      {
        origin: "CRM",
        lastOmieWire: mapped.wire,
        changedBy: input.actorId ?? sync.changedBy,
      },
    );
    return;
  }

  if (!crmAhead && omieAhead) {
    if (!snapshot) {
      return;
    }
    const omieRead = readSnapshotField(snapshot, fieldKey);
    if (omieRead.status === "skip") {
      return;
    }
    const marked = await store.markSynced(
      owner,
      fieldKey,
      { localVersion: sync.localVersion, externalVersion: sync.externalVersion },
      { origin: "OMIE_SYNC", changedBy: "OMIE_SYNC" },
    );
    if (!marked) {
      return;
    }
    setBusinessValue(customer, vehicle, fieldKey, omieRead.crm);
    // Save a copy read NOW, not the caller's: the caller's was read before at least one
    // Omie call (`adapter.get`, and a `put` per earlier CRM-ahead field), and
    // `saveCustomer` replaces the phone and e-mail rows, so saving it would delete a
    // contact or undo a column edited in that window. No provider call sits between
    // this read and the save below.
    const fresh = await store.getCustomer(customer.id);
    if (!fresh) {
      return;
    }
    const freshVehicle = vehicle ? await store.getVehicle(vehicle.id) : null;
    setBusinessValue(fresh, freshVehicle, fieldKey, omieRead.crm);
    await store.saveCustomer(fresh);
    if (freshVehicle) {
      await store.saveVehicle(freshVehicle);
    }
  }
}
