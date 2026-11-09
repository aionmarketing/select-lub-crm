/**
 * In-process plate provider backed by {@link mockPlacasDataset}. Never calls HTTP.
 */
import { foundOrNotFound, type PlateProvider } from "../port.js";
import { mockPlacasDataset, mockRowOutcome } from "./dataset.js";

/** Vendor name recorded on mock results so callers can tell them from provider answers. */
export const MOCK_PROVIDER = "mock";

/**
 * Builds a {@link PlateProvider} that resolves plates from the canned dataset.
 *
 * Unknown plates are `not_found`, still tagged `source: "mock"` and unbilled, so
 * a credentialed run later is not poisoned by a cached fabricated miss.
 *
 * @returns A provider named `mock`.
 */
export function createMockPlateProvider(): PlateProvider {
  const rows = new Map(mockPlacasDataset().map((row) => [row.plate, row]));
  return {
    name: MOCK_PROVIDER,
    async lookup(plate) {
      const row = rows.get(plate);
      if (!row) {
        return foundOrNotFound({}, { source: "mock", provider: MOCK_PROVIDER, billed: false });
      }
      return mockRowOutcome(row);
    },
  };
}
