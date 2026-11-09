/**
 * `correctVehicleVersion` — the quote's engine pick corrects a vehicle's version (customer-vehicles
 * "The quote's engine pick corrects the version"; background-oil-research D24 F4, owner 2026-09-30).
 *
 * The trim is kept. When the version already names an engine — from a displacement token such as
 * `1.0`, `1,6` or `1.0L` to the end — that part is replaced ("XEi 1.0" becomes "XEi 1.6",
 * "Comfortline 1.0 TSI" becomes "Comfortline 1.4 TSI"); when it names none, the engine is appended
 * after one space ("XEi" becomes "XEi 1.8 Dual VVT-i"). A version that already contains the picked
 * engine is left as it is.
 *
 * The write is a compare-and-set on the version the caller computed from, then the vehicle update
 * the rail's form runs (`applyVehicleFieldEdit`). The version is not an Omie shared key, so the
 * edit takes the rail's local path and is not mirrored to Omie. The field's origin is then written
 * `CRM` — a `PLACA` version included, so the assistive prefill may suggest it again — and
 * `customers/vehicle-changed` is announced. It writes only that vehicle and starts no research.
 */
import type { OmieAdapter } from "../../../kernel/clients/erp-mock.js";
import type { Db } from "../../../kernel/db.js";
import { publish } from "../../../kernel/events.js";
import { vehicleToDto } from "./cadastro-dto.js";
import { applyVehicleFieldEdit } from "./cadastro-engine/index.js";
import { createCadastroStore } from "./cadastro-store/index.js";
import { createPlateOriginStore } from "./cadastro-store/plate-origin.js";
import type { Vehicle } from "./http.js";
import { vehicleChanged } from "./vehicle-changed.js";

/**
 * The longest version the field takes (D24: a corrected version too long for it is refused). The
 * column itself is unbounded; this is the bound the engine pick holds a corrected version to, so an
 * engine name appended to an already long trim cannot grow the field without limit.
 */
export const VEHICLE_VERSION_MAX_LENGTH = 60;

/**
 * A displacement token, where a version starts naming its engine: `1.0`, `1,6`, `2.0`, `1.0L`.
 * Everything from it to the end is the engine part (orchestrator, 2026-10-01).
 */
const DISPLACEMENT = /(^|\s)\d[.,]\dL?(?=\s|$)/i;

const squash = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The version corrected with an engine, keeping the trim (orchestrator ruling, 2026-10-01).
 *
 * @param version - The vehicle's version, as stored.
 * @param engine - The engine the clarification named, verbatim.
 * @returns The corrected version: unchanged when it already contains that engine; when it names
 *   an engine (a displacement token), the text before the token kept as the trim and everything
 *   from the token to the end replaced by the engine ("Comfortline 1.0 TSI" + "1.4 TSI" →
 *   "Comfortline 1.4 TSI"); otherwise the engine appended after one space.
 */
export function versionWithEngine(version: string, engine: string): string {
  const trimmed = version.trim().replace(/\s+/g, " ");
  const picked = engine.trim().replace(/\s+/g, " ");
  if (squash(trimmed).includes(squash(picked))) return trimmed;
  const named = DISPLACEMENT.exec(trimmed);
  if (named) {
    const trim = trimmed.slice(0, named.index + named[1]!.length).trimEnd();
    return trim === "" ? picked : `${trim} ${picked}`;
  }
  return trimmed === "" ? picked : `${trimmed} ${picked}`;
}

/** What the correction did. */
export type CorrectVehicleVersionResult =
  | { status: "ok"; vehicle: Vehicle }
  | { status: "not_found" }
  | { status: "version_too_long" }
  /** The version is no longer the one the correction was computed from: nothing was written. */
  | { status: "version_changed" }
  /** The vehicle edit did not save (not linked, or Omie refused a titular write). */
  | { status: "not_saved" };

/**
 * Corrects one vehicle's version, computed once by the caller (with {@link versionWithEngine}),
 * as a compare-and-set on the version it was computed from (orchestrator, 2026-10-01): when the
 * vehicle's version changed meanwhile — another pick, a rail edit — nothing is written.
 *
 * @param db - The database handle; the stores run each call in `db.tx("customers", …)`.
 * @param omieAdapter - The caller's Omie adapter, called outside any transaction (the version is
 *   not an Omie shared key, so the edit takes the rail's local path and is not mirrored).
 * @param input.vehicleId - The vehicle, already scoped by the caller.
 * @param input.unitId - The caller's unit; a vehicle of another unit is `not_found`.
 * @param input.fromVersion - The version the correction was computed from, as stored.
 * @param input.version - The corrected version.
 * @param input.actorId - The session user.
 * @returns The saved vehicle, or why nothing was written.
 */
export async function correctVehicleVersion(
  db: Db,
  omieAdapter: OmieAdapter,
  input: { vehicleId: string; unitId: string; fromVersion: string | null; version: string; actorId?: string },
): Promise<CorrectVehicleVersionResult> {
  const cadastro = createCadastroStore(db);
  const current = await cadastro.getVehicle(input.vehicleId);
  if (!current) return { status: "not_found" };
  const owner = await cadastro.getCustomer(current.customerId);
  if (!owner || owner.unitId !== input.unitId) return { status: "not_found" };
  const version = input.version.trim();
  if (version.length > VEHICLE_VERSION_MAX_LENGTH) return { status: "version_too_long" };
  // The compare-and-set: only the version the correction was computed from is replaced.
  const { count } = await db.tx("customers", (tx) =>
    tx.vehicle.updateMany({ where: { id: input.vehicleId, version: input.fromVersion }, data: { version } }),
  );
  if (count !== 1) return { status: "version_changed" };
  // Then the rail's own edit of the same value, for its bookkeeping (sync version, saved row).
  const result = await applyVehicleFieldEdit(cadastro, omieAdapter, {
    vehicleId: input.vehicleId,
    unitId: input.unitId,
    patch: { version },
    ...(input.actorId ? { actorId: input.actorId } : {}),
  });
  if (result.status === "not_found" || result.status === "unit_mismatch") return { status: "not_found" };
  if (result.status !== "ok") return { status: "not_saved" };
  const origins = createPlateOriginStore(db);
  await origins.writeFieldOrigin(input.vehicleId, "version", "CRM", input.actorId ?? null);
  await publish(vehicleChanged, {
    vehicleId: result.vehicle.id,
    customerId: result.vehicle.customerId,
    unitId: input.unitId,
    fields: ["version"],
    actorId: input.actorId ?? null,
    created: false,
  });
  return { status: "ok", vehicle: vehicleToDto(result.vehicle, await origins.listPlateSourcedKeys(input.vehicleId)) };
}
