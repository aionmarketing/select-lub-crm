/**
 * Port for mock per-vehicle Omie identifiers.
 *
 * Unvalidated stand-in: the real Omie vehicle mapping is GitHub #29. Values MUST NOT be
 * pushed to a live Omie tenant and MUST NOT be presented as a confirmed mapping.
 */
import type { MockVehicleIdentifier } from "./dataset.js";

/** Lists mock vehicle Omie ids. Never opens a network connection. */
export type OmieVehicleIdsPort = {
  /**
   * Returns every mock vehicle identifier.
   *
   * @returns Cloned rows; each `vehicleOmieId` is mock-origin only.
   */
  listVehicleIds(): Promise<MockVehicleIdentifier[]>;
};

/**
 * In-memory vehicle-id port seeded from the mock dataset.
 *
 * @param rows - Dataset clone the source owns.
 * @returns Port whose `listVehicleIds` returns a clone of `rows`.
 */
export function createMockVehicleIdsPort(rows: MockVehicleIdentifier[]): OmieVehicleIdsPort {
  return {
    async listVehicleIds() {
      return structuredClone(rows);
    },
  };
}
