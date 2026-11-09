/**
 * Loads the selected mock Omie dataset: small fixture, or the generated TIDSCI JSON.
 *
 * Unvalidated stand-in mapped from TIDSCI tables, not a live Omie contract
 * (GitHub #27 / #29 / #5). Never opens a network connection.
 */
import { readFileSync } from "node:fs";
import { mockOmieDataset } from "../dataset.js";
import type {
  MockCatalogProduct,
  MockDuplicatePair,
  MockOmieClient,
  MockServiceOrder,
  MockVehicleIdentifier,
} from "../dataset.js";
import { isTidsciMockDataset, tidsciDatasetPath } from "./paths.js";

export type LoadedMockOmieDataset = {
  clients: MockOmieClient[];
  serviceOrders: MockServiceOrder[];
  products: MockCatalogProduct[];
  vehicleIds: MockVehicleIdentifier[];
  duplicatePairs: MockDuplicatePair[];
};

/**
 * Thrown when `OMIE_MOCK_DATASET=tidsci` and the generated JSON file is missing.
 *
 * Callers must not fall back to {@link mockOmieDataset}.
 */
export class TidsciDatasetMissingError extends Error {
  constructor(path: string) {
    super(
      `OMIE_MOCK_DATASET=tidsci but the generated dataset file is missing at ${path}. Run pnpm --filter @select-lub/core tidsci:generate first.`,
    );
    this.name = "TidsciDatasetMissingError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reads and parses the generated TIDSCI dataset JSON.
 *
 * @param path - File path; typically `.local/tidsci-omie-dataset.json`.
 * @returns The five mock surfaces.
 * @throws {@link TidsciDatasetMissingError} when the file does not exist.
 * @throws `Error` when the JSON is not an object with array surfaces.
 */
export function readTidsciDatasetFile(path: string): LoadedMockOmieDataset {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new TidsciDatasetMissingError(path);
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) {
    throw new Error(`TIDSCI dataset at ${path} is not a JSON object`);
  }
  const clients = parsed.clients;
  const serviceOrders = parsed.serviceOrders;
  const products = parsed.products;
  const vehicleIds = parsed.vehicleIds;
  const duplicatePairs = parsed.duplicatePairs;
  if (
    !Array.isArray(clients) ||
    !Array.isArray(serviceOrders) ||
    !Array.isArray(products) ||
    !Array.isArray(vehicleIds) ||
    !Array.isArray(duplicatePairs)
  ) {
    throw new Error(`TIDSCI dataset at ${path} is missing clients/serviceOrders/products/vehicleIds/duplicatePairs arrays`);
  }
  return {
    clients: clients as MockOmieClient[],
    serviceOrders: serviceOrders as MockServiceOrder[],
    products: products as MockCatalogProduct[],
    vehicleIds: vehicleIds as MockVehicleIdentifier[],
    duplicatePairs: duplicatePairs as MockDuplicatePair[],
  };
}

/**
 * Returns the small fixture unless `OMIE_MOCK_DATASET=tidsci`, in which case it
 * reads the generated JSON (or throws if that file is missing).
 *
 * @param env - Environment map; defaults to `process.env`.
 * @returns Dataset clone for {@link createMockOmie}.
 * @throws {@link TidsciDatasetMissingError} when the tidsci opt-in is set and the file is absent.
 */
export function loadSelectedMockOmieDataset(
  env: NodeJS.ProcessEnv = process.env,
): LoadedMockOmieDataset {
  if (!isTidsciMockDataset(env)) {
    return mockOmieDataset();
  }
  return readTidsciDatasetFile(tidsciDatasetPath(env));
}
