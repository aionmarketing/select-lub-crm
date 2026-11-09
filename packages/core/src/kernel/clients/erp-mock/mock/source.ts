/**
 * Selectable mock Omie source: client fake plus OS, products, vehicle ids, and duplicates.
 */
import { createFakeOmie } from "../fake.js";
import { createMockDuplicateCandidatesPort } from "./duplicates.js";
import { createMockProductsPort } from "./products.js";
import { createMockServiceOrdersPort } from "./service-orders.js";
import { loadSelectedMockOmieDataset, type LoadedMockOmieDataset } from "./tidsci/load.js";
import { createMockVehicleIdsPort } from "./vehicle-ids.js";

/**
 * Builds a mock Omie source seeded from {@link mockOmieDataset}, or from the
 * generated TIDSCI JSON when `OMIE_MOCK_DATASET=tidsci`.
 *
 * TIDSCI ids are mock-origin stand-ins mapped from archive tables, not live Omie
 * keys (GitHub #27 / #29 / #5). Missing JSON throws rather than falling back.
 *
 * Controls (`driftClient`, `arrangeDualChange`, `failReads`) mutate this instance only.
 * Requests never open a network connection.
 *
 * @param env - Environment map; defaults to `process.env`. `OMIE_MOCK_DATASET=tidsci`
 *   loads `OMIE_MOCK_TIDSCI_PATH` (default `.local/tidsci-omie-dataset.json`).
 * @param options.idPrefix - Prepended to every Omie identifier in the dataset
 *   (client, service order, vehicle, product, duplicate pair), consistently, so
 *   each reference still resolves. Tests pass one of their own so their pull
 *   writes rows no other test and no demo seed shares; production and the demo
 *   seed pass none.
 * @returns Client `OmieSyncPort` plus the non-client ports and mock controls.
 * @throws {@link TidsciDatasetMissingError} when the tidsci opt-in is set and the file is absent.
 */
export function createMockOmie(env: NodeJS.ProcessEnv = process.env, options: { idPrefix?: string } = {}) {
  const loaded = loadSelectedMockOmieDataset(env);
  const data = options.idPrefix ? prefixMockOmieIds(loaded, options.idPrefix) : loaded;
  const clients = createFakeOmie();
  for (const client of data.clients) {
    clients.seed(client.omieId, client.snapshot, client.alteredAt);
  }

  return {
    clients,
    serviceOrders: createMockServiceOrdersPort(data.serviceOrders),
    products: createMockProductsPort(data.products),
    vehicleIds: createMockVehicleIdsPort(data.vehicleIds),
    duplicates: createMockDuplicateCandidatesPort(data.duplicatePairs),
    /**
     * Changes a mock client's field values and alteration timestamp (deterministic drift).
     *
     * @param omieId - Seeded Omie client id.
     * @param patch.razao_social - Optional new razão social.
     * @param patch.cep - Optional new CEP wire.
     * @param patch.alteredAt - ISO timestamp that later incremental `listPage` filters use.
     * @returns `void`; no-op when `omieId` is unknown.
     */
    async driftClient(
      omieId: string,
      patch: { razao_social?: string | null; cep?: string | null; alteredAt: string },
    ) {
      const snapshot = await clients.get(omieId);
      if (!snapshot) {
        return;
      }
      if (patch.razao_social !== undefined) {
        snapshot.razao_social = patch.razao_social;
      }
      if (patch.cep !== undefined) {
        snapshot.cep = patch.cep;
      }
      clients.seed(omieId, snapshot, patch.alteredAt);
    },
    /**
     * Drifts Omie `cep` so a refresh plus an un-pushed CRM postalCode opens a pending.
     *
     * @param omieId - Seeded Omie client id.
     * @returns The postalCode the CRM should hold un-pushed (`CRMCEP12`); Omie wire becomes `OMIECEP1`.
     */
    async arrangeDualChange(omieId: string) {
      await this.driftClient(omieId, {
        cep: "OMIECEP1",
        alteredAt: "2026-09-01T12:00:00.000Z",
      });
      return { fieldKey: "postalCode" as const, crmValue: "CRMCEP12" };
    },
    /**
     * Makes subsequent client reads throw `omie_unavailable` (simulated outage).
     *
     * @returns `void`.
     */
    failReads() {
      clients.failReads();
    },
  };
}

export type MockOmieSource = ReturnType<typeof createMockOmie>;

/**
 * The dataset with `prefix` before every Omie identifier and every reference to
 * one, so the prefixed dataset is internally consistent. Names, plates, phones
 * and tax ids are left as they are.
 *
 * @param data - A loaded dataset.
 * @param prefix - Prepended to each id.
 * @returns A new dataset; `data` is not changed.
 */
export function prefixMockOmieIds(data: LoadedMockOmieDataset, prefix: string): LoadedMockOmieDataset {
  const id = (value: string) => `${prefix}${value}`;
  return {
    clients: data.clients.map((client) => ({ ...client, omieId: id(client.omieId) })),
    serviceOrders: data.serviceOrders.map((order) => ({
      ...order,
      omieId: id(order.omieId),
      clientOmieId: id(order.clientOmieId),
      vehicleOmieId: order.vehicleOmieId === null ? null : id(order.vehicleOmieId),
    })),
    products: data.products.map((product) => ({ ...product, omieId: id(product.omieId) })),
    vehicleIds: data.vehicleIds.map((row) => ({
      ...row,
      vehicleOmieId: id(row.vehicleOmieId),
      clientOmieId: id(row.clientOmieId),
    })),
    duplicatePairs: data.duplicatePairs.map((pair) => ({
      leftOmieId: id(pair.leftOmieId),
      rightOmieId: id(pair.rightOmieId),
    })),
  };
}
