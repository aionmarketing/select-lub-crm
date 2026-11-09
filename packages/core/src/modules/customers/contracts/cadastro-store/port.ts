/**
 * Cadastro persistence port and row shapes used by the Omie sync engine.
 */
import type { OmieSharedFieldKey } from "../../../../shared/web/omie-field-keys.js";
import type { VehicleOmieSync } from "../http.omie-sync.js";
import type { OmieClientSnapshot } from "../../../../kernel/clients/erp-mock.js";

/** Which side last won a shared field — CRM edit or Omie pull. */
export type FieldOrigin = "CRM" | "OMIE_SYNC";

/** One phone on a customer row, with raw display text and normalized digits for matching. */
export type PhoneRow = {
  raw: string;
  normalized: string;
  isPrimary: boolean;
  updatedAt?: string;
};

/** One email on a customer row, with raw display text and normalized address for matching. */
export type EmailRow = { raw: string; normalized: string; isPrimary: boolean };

/**
 * Which customers the pull's match pass may consider.
 *
 * Absent in production: matching is database-wide, every unlinked customer with
 * a tax id or primary phone. Tests pass their own customers, because a match
 * UPDATEs every candidate it links or pushes and holds those rows until the test
 * rolls back — database-wide, every pull-running test locked every unlinked demo
 * customer and the files queued behind each other.
 */
export type MatchCandidateScope = { customerIds: readonly string[] };

/** CRM customer row as stored by the cadastro port, including Omie link and shared address fields. */
export type CustomerRecord = {
  id: string;
  name: string | null;
  omieId: string | null;
  taxId: string | null;
  unitId: string | null;
  givenName: string | null;
  familyName: string | null;
  mergedIntoId: string | null;
  street: string | null;
  streetNumber: string | null;
  neighborhood: string | null;
  complement: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  origin: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  phones: PhoneRow[];
  emails: EmailRow[];
};

/** CRM vehicle row as stored by the cadastro port, linked to a titular customer. */
export type VehicleRecord = {
  id: string;
  customerId: string;
  omieId: string | null;
  plate: string | null;
  make: string | null;
  model: string | null;
  version: string | null;
  year: number | null;
  odometerKm: number | null;
  origin: string;
  createdAt: string;
  updatedAt: string;
};

/** Per-field sync metadata tracking local and Omie versions for conflict detection. */
export type FieldSyncRow = {
  fieldKey: OmieSharedFieldKey;
  origin: FieldOrigin;
  localVersion: number;
  externalVersion: number;
  syncedLocalVersion: number;
  syncedExternalVersion: number;
  lastOmieWire: string | null;
  lastAttemptedAt: string | null;
  lastResult: string | null;
  lastError: string | null;
  changedBy: string | null;
};

/** Open reconciliation row when CRM and Omie disagree on a shared field. */
export type PendingRow = {
  fieldKey: OmieSharedFieldKey;
  crmValue: string;
  omieValue: string;
  localVersion: number;
  externalVersion: number;
  status: "open" | "resolved";
  customerId: string;
  vehicleId: string | null;
  resolvedByUserId?: string | null;
};

/** Identifies whether sync state belongs to a customer person field or a vehicle field. */
export type SyncOwner = { customerId: string } | { vehicleId: string };

/** Persistence port for customers, vehicles, field sync rows, and reconciliation pendings. */
export type CadastroStore = {
  /**
   * Loads one customer by CRM id.
   *
   * @param id - CRM customer uuid.
   * @returns Customer row, or `null` when no row exists.
   */
  getCustomer(id: string): Promise<CustomerRecord | null>;
  /**
   * Upserts a full customer row.
   *
   * @param customer - Complete customer record to persist; `id` is the upsert key.
   * @returns Resolves when the row is stored.
   */
  saveCustomer(customer: CustomerRecord): Promise<void>;
  /**
   * Finds the most recently updated customer in a unit with a matching normalized phone.
   *
   * @param unitId - CRM unit id restricting the search.
   * @param normalized - Digit-only phone key; must match `PhoneRow.normalized` exactly.
   * @returns Most recently touched matching customer, or `null` when none match.
   */
  findCustomerByPhone(unitId: string, normalized: string): Promise<CustomerRecord | null>;
  /**
   * Creates a placeholder customer and titular vehicle from an inbound WhatsApp number.
   *
   * @param input.unitId - Unit that owns the new cadastro.
   * @param input.phoneNormalized - Digit-only phone stored as the primary contact. `name` stays null until filled.
   * @param input.phoneRaw - Display/raw phone string for the primary `PhoneRow.raw`.
   * @returns New customer and titular vehicle with `origin: "whatsapp"` and no Omie link.
   */
  createWhatsappCadastro(input: {
    unitId: string;
    phoneNormalized: string;
    phoneRaw: string;
  }): Promise<{ customer: CustomerRecord; vehicle: VehicleRecord }>;
  /**
   * Returns the titular vehicle for a customer (earliest `createdAt`).
   *
   * @param customerId - CRM customer uuid.
   * @returns Titular vehicle row, or `null` when the customer has no vehicles.
   */
  getVehicleForCustomer(customerId: string): Promise<VehicleRecord | null>;
  /**
   * Lists all vehicles for a customer ordered by titular precedence.
   *
   * @param customerId - CRM customer uuid.
   * @returns Vehicles sorted by `compareVehiclesByTitularOrder` (titular first).
   */
  listVehicles(customerId: string): Promise<VehicleRecord[]>;
  /**
   * Loads one vehicle by CRM id.
   *
   * @param id - CRM vehicle uuid.
   * @returns Vehicle row, or `null` when missing.
   */
  getVehicle(id: string): Promise<VehicleRecord | null>;
  /**
   * Inserts a new vehicle row.
   *
   * @param vehicle - Complete vehicle record; fails or overwrites depending on implementation when `id` already exists.
   * @returns Resolves when the row is stored.
   */
  createVehicle(vehicle: VehicleRecord): Promise<void>;
  /**
   * Upserts a full vehicle row.
   *
   * @param vehicle - Complete vehicle record to persist; `id` is the upsert key.
   * @returns Resolves when the row is stored.
   */
  saveVehicle(vehicle: VehicleRecord): Promise<void>;
  /**
   * Loads sync metadata for one shared field on a customer or vehicle owner.
   *
   * @param owner - `{ customerId }` for person fields or `{ vehicleId }` for vehicle fields.
   * @param fieldKey - Shared Omie field key.
   * @returns Sync row, or `null` before any version bumps.
   */
  getSync(owner: SyncOwner, fieldKey: OmieSharedFieldKey): Promise<FieldSyncRow | null>;
  /**
   * Rolls one vehicle's Omie synchronisation state up from its per-field rows.
   *
   * Implementations MUST delegate the ranking to `buildVehicleOmieSync` from
   * `contracts/http.omie-sync.ts` rather than deciding it themselves, so the
   * memory fake and Postgres cannot report different states for the same rows.
   *
   * @param vehicleId - CRM vehicle primary key (not the Omie id).
   * @returns One of never-synced / synced / failed / conflict, or `null` when no such vehicle exists.
   */
  getVehicleOmieSync(vehicleId: string): Promise<VehicleOmieSync | null>;
  /**
   * Increments the local version after a CRM-side edit to a shared field.
   *
   * @param owner - Customer or vehicle sync owner; must match `fieldKey` person vs vehicle rules.
   * @param fieldKey - Shared field that changed on the CRM side.
   * @param changedBy - Actor id or `null` for system edits.
   * @returns Resolves after bumping `localVersion` and setting `origin` to `"CRM"`.
   * @throws Memory store throws when owner/fieldKey pairing is invalid (person key on vehicle owner or vice versa).
   */
  bumpLocal(owner: SyncOwner, fieldKey: OmieSharedFieldKey, changedBy: string | null): Promise<void>;
  /**
   * Increments the external version after Omie wire value changes for a shared field.
   *
   * @param owner - Customer or vehicle sync owner.
   * @param fieldKey - Shared field whose Omie wire changed.
   * @param wire - Latest Omie wire string stored in `lastOmieWire`.
   * @returns Resolves after bumping `externalVersion` and setting `origin` to `"OMIE_SYNC"`.
   * @throws Memory store throws when owner/fieldKey pairing is invalid.
   */
  bumpExternal(owner: SyncOwner, fieldKey: OmieSharedFieldKey, wire: string): Promise<void>;
  /**
   * Marks local and external versions as synced when they still match the expected pair.
   *
   * @param owner - Customer or vehicle sync owner.
   * @param fieldKey - Shared field being marked in sync.
   * @param expected - `localVersion` and `externalVersion` that must still match the stored row.
   * @param patch - Winning `origin`, optional `lastOmieWire`, and `changedBy` actor label.
   * @returns `true` when versions matched and the row was updated; `false` on version mismatch or missing sync row.
   */
  markSynced(
    owner: SyncOwner,
    fieldKey: OmieSharedFieldKey,
    expected: { localVersion: number; externalVersion: number },
    patch: { origin: FieldOrigin; lastOmieWire?: string; changedBy: string | null },
  ): Promise<boolean>;
  /**
   * Records the outcome of the last Omie push attempt for a shared field.
   *
   * @param owner - Customer or vehicle sync owner.
   * @param fieldKey - Shared field that was pushed.
   * @param outcome.result - `"ok"` or `"failed"`.
   * @param outcome.error - Error code or message when failed; `null` on success.
   * @returns Resolves when the sync row is updated; no-op when no sync row exists.
   */
  recordAttempt(
    owner: SyncOwner,
    fieldKey: OmieSharedFieldKey,
    outcome: { result: "ok" | "failed"; error: string | null },
  ): Promise<void>;
  /**
   * Loads the open reconciliation row for a shared field.
   *
   * @param owner - Customer or vehicle sync owner.
   * @param fieldKey - Shared field in conflict.
   * @returns Open pending row, or `null` when none is open.
   */
  getOpenPending(owner: SyncOwner, fieldKey: OmieSharedFieldKey): Promise<PendingRow | null>;
  /**
   * Persists or replaces the open reconciliation row for a shared field.
   *
   * @param row - Pending row with `status: "open"`; `vehicleId` selects vehicle owner when non-null.
   * @returns Resolves when the pending row is stored.
   */
  saveOpenPending(row: PendingRow): Promise<void>;
  /**
   * Closes the open reconciliation row for a shared field.
   *
   * @param owner - Customer or vehicle sync owner.
   * @param fieldKey - Shared field being resolved.
   * @param resolvedByUserId - CRM user id that closed the pending.
   * @returns `true` when an open row was marked `resolved`; `false` when none was open.
   */
  closeOpenPending(
    owner: SyncOwner,
    fieldKey: OmieSharedFieldKey,
    resolvedByUserId: string,
  ): Promise<boolean>;
  /**
   * Lists open reconciliation rows for a customer and their titular vehicle.
   *
   * @param customerId - CRM customer uuid.
   * @returns Open pendings owned by the customer or their titular vehicle only.
   */
  listOpenPendings(customerId: string): Promise<PendingRow[]>;
  /**
   * Lists open reconciliation rows for every customer in a unit.
   *
   * @param unitId - CRM unit id.
   * @returns Open pendings with `customerName` for UI display.
   */
  listOpenPendingsForUnit(
    unitId: string,
  ): Promise<Array<PendingRow & { customerName: string }>>;
  /**
   * Finds a customer already linked to the given Omie id.
   *
   * @param omieId - Omie `codigo_cliente_omie` string.
   * @returns Linked customer, or `null` when no CRM row has that `omieId`.
   */
  findCustomerByOmieId(omieId: string): Promise<CustomerRecord | null>;
  /**
   * Lists unlinked customers that have enough tax id or phone data to attempt Omie matching.
   *
   * @param scope - Restricts the list to these customers. Production passes nothing
   *   and matches database-wide; a test passes its own customers, so its pull never
   *   links or locks another suite's rows (see {@link MatchCandidateScope}).
   * @returns Customers with `omieId: null` and a non-empty digit-only tax id or primary phone.
   */
  listUnlinkedMatchCandidates(scope?: MatchCandidateScope): Promise<CustomerRecord[]>;
  /**
   * Writes a customer's own columns — never its phone or e-mail rows.
   *
   * For the match pass, which links a candidate read before the slow Omie listing:
   * a phone or e-mail added in that window must survive the link, so this cannot be
   * `saveCustomer`, which replaces the contact rows from the stale snapshot.
   *
   * @param customer - Customer whose columns (`omieId` included) are written by `id`.
   * @returns Resolves when the row is updated.
   */
  saveCustomerColumns(customer: CustomerRecord): Promise<void>;
  /**
   * Creates or updates a customer from an Omie pull snapshot keyed by Omie id.
   *
   * @param input.omieId - Omie client id used as the upsert key.
   * @param input.snapshot - Latest Omie wire snapshot for shared person fields.
   * @returns Created or updated customer row.
   */
  upsertByOmieId(input: {
    omieId: string;
    snapshot: OmieClientSnapshot;
  }): Promise<CustomerRecord>;
};

/**
 * Sort comparator that orders vehicles with the titular (earliest created) first.
 *
 * @param a - First vehicle row.
 * @param b - Second vehicle row.
 * @returns Negative when `a` is titular before `b`, positive when after, zero when tied on `createdAt` and `id`.
 */
export function compareVehiclesByTitularOrder(a: VehicleRecord, b: VehicleRecord) {
  const byCreatedAt = a.createdAt.localeCompare(b.createdAt);
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }
  return a.id.localeCompare(b.id);
}

/**
 * Returns a zeroed sync row for a shared field before any CRM or Omie changes.
 *
 * @param fieldKey - Shared field the row will track.
 * @returns Fresh `FieldSyncRow` with versions `0`, `origin: "CRM"`, and null attempt metadata.
 */
export function emptySync(fieldKey: OmieSharedFieldKey): FieldSyncRow {
  return {
    fieldKey,
    origin: "CRM",
    localVersion: 0,
    externalVersion: 0,
    syncedLocalVersion: 0,
    syncedExternalVersion: 0,
    lastOmieWire: null,
    lastAttemptedAt: null,
    lastResult: null,
    lastError: null,
    changedBy: null,
  };
}
