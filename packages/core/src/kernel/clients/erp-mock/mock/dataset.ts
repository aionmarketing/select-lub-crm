/**
 * Deterministic mock Omie identifiers shared by the mock source, worker import, and demo seed.
 *
 * Vehicle ids and duplicate pairs are unvalidated stand-ins (GitHub #29 and #5).
 */
import { emptySnapshot, type OmieClientSnapshot } from "../map.js";

/** One mock Omie client row with the snapshot the fake adapter stores. */
export type MockOmieClient = {
  omieId: string;
  snapshot: OmieClientSnapshot;
  alteredAt: string;
};

/**
 * One mock OS line item (NF `NotaFiscalSaidasItens` on the TIDSCI dataset).
 *
 * Header-only fixture orders omit `items`; import then stores an empty list.
 */
export type MockServiceOrderItem = {
  description: string;
  kind?: string | null;
  quantity: number | null;
  unitAmount: number | null;
  lineAmount: number | null;
  oilViscosity?: string | null;
};

/**
 * Per-client service order as the mock OS port returns it.
 *
 * @remarks Origin is always mock; `omieId` is the import upsert key.
 *   `performedAt` is null when a TIDSCI date integer cannot be decoded.
 */
export type MockServiceOrder = {
  omieId: string;
  clientOmieId: string;
  /**
   * The vehicle the work was done on, as {@link MockVehicleIdentifier.vehicleOmieId}.
   *
   * Null when the order names no car. Without it a service cannot open a vehicle
   * return, because a return is per vehicle — so an order with no vehicle
   * produces a service that never becomes a return.
   */
  vehicleOmieId: string | null;
  /** Plate copied from the archive auto row; import also matches this against CRM vehicles. */
  plate?: string | null;
  performedAt: string | null;
  description: string;
  kind: string;
  status: string;
  amount: number | null;
  odometerKm: number | null;
  items?: MockServiceOrderItem[];
};

/**
 * Catalog product as the mock product port returns it.
 *
 * `omieId` is also the CRM `CatalogItem.id` so a seed then import is a no-op.
 *
 * An oil carries `viscosity` (and optionally `classification`, empty when unknown, and
 * `oilType`, absent when unknown — add-lubricant-oil-type); import writes a lubricant-detail
 * row for it, and a re-import sets the oil type to the product's current one, clearing it
 * when the product no longer carries one. A filter (tecfil-filter-pricing D12)
 * carries `filterType` and `partNumber`; import writes a filter-detail row for it. A
 * product carries at most one of the two detail shapes — never both. A product with
 * neither is not an oil or a filter and imports as a catalog item alone.
 */
export type MockCatalogProduct = {
  omieId: string;
  brand: string;
  description: string;
  price: number;
  stock: number;
  active: boolean;
  viscosity?: string;
  classification?: string;
  /** Base-oil type; oils only. The real Omie mapping is unknown (GitHub #27/#29). */
  oilType?: "SINTETICO" | "SEMISSINTETICO" | "MINERAL";
  filterType?: "OLEO" | "COMBUSTIVEL";
  partNumber?: string;
};

/**
 * Per-vehicle Omie identifier stand-in.
 *
 * Unvalidated: the real Omie vehicle mapping is GitHub #29. Must not be pushed to a live tenant.
 */
export type MockVehicleIdentifier = {
  vehicleOmieId: string;
  clientOmieId: string;
  plate: string;
};

/**
 * Two Omie client ids the mock reports as the same person.
 *
 * Unvalidated: merge behavior is GitHub #5. Surfacing must not set `mergedInto` or delete rows.
 */
export type MockDuplicatePair = {
  leftOmieId: string;
  rightOmieId: string;
};

const LINKED: MockOmieClient = {
  omieId: "omie-mock-linked",
  alteredAt: "1970-01-01T00:00:00.000Z",
  snapshot: {
    ...emptySnapshot(),
    razao_social: "Maria Linked",
    telefone: "11970000001",
    cep: "13010000",
    codigo_pais: "1058",
    caracteristicas: [{ campo: "Placa", conteudo: "ABC1D23" }],
  },
};

const MATCHABLE: MockOmieClient = {
  omieId: "omie-mock-matchable",
  alteredAt: "1970-01-01T00:00:00.000Z",
  snapshot: {
    ...emptySnapshot(),
    razao_social: "Paulo Matchable",
    telefone: "11970000002",
  },
};

const DUP_A: MockOmieClient = {
  omieId: "omie-mock-dup-a",
  alteredAt: "1970-01-01T00:00:00.000Z",
  snapshot: { ...emptySnapshot(), razao_social: "Dup A", cnpj_cpf: "52998224725" },
};

const DUP_B: MockOmieClient = {
  omieId: "omie-mock-dup-b",
  alteredAt: "1970-01-01T00:00:00.000Z",
  snapshot: { ...emptySnapshot(), razao_social: "Dup B", cnpj_cpf: "52998224725" },
};

const SERVICE: MockServiceOrder = {
  omieId: "os-mock-1",
  clientOmieId: LINKED.omieId,
  vehicleOmieId: "veh-omie-mock-1",
  performedAt: "2026-01-15T12:00:00.000Z",
  description: "Troca de oleo",
  kind: "oleo",
  status: "concluido",
  amount: 350,
  odometerKm: 42000,
};

const PRODUCT: MockCatalogProduct = {
  omieId: "cat-motul-8100-5w30",
  brand: "Motul",
  description: "8100 Eco-nergy",
  price: 189.9,
  stock: 0,
  active: true,
  viscosity: "5W-30",
  classification: "API SERVICE SQ-RC, ILSAC GF-7A",
  // Same as the seed row of this id, so seed-then-import stays a no-op.
  oilType: "SINTETICO",
};

/**
 * Tecfil oil filter for the sample vehicle, same `omieId` as the `catalog-seed.ts` row
 * `cat-tecfil-pel108` so seeding and importing the mock agree on one catalog item.
 */
const TECFIL_OIL_FILTER_PRODUCT: MockCatalogProduct = {
  omieId: "cat-tecfil-pel108",
  brand: "Tecfil",
  description: "Filtro de óleo PEL108",
  price: 32,
  stock: 0,
  active: true,
  filterType: "OLEO",
  partNumber: "PEL108",
};

/**
 * Tecfil fuel filter for the sample vehicle, same `omieId` as `cat-tecfil-gi50-7`.
 */
const TECFIL_FUEL_FILTER_PRODUCT: MockCatalogProduct = {
  omieId: "cat-tecfil-gi50-7",
  brand: "Tecfil",
  description: "Filtro de combustível GI50/7",
  price: 45,
  stock: 0,
  active: true,
  filterType: "COMBUSTIVEL",
  partNumber: "GI50/7",
};

const VEHICLE: MockVehicleIdentifier = {
  vehicleOmieId: "veh-omie-mock-1",
  clientOmieId: LINKED.omieId,
  plate: "ABC1D23",
};

const DUPLICATE: MockDuplicatePair = {
  leftOmieId: DUP_A.omieId,
  rightOmieId: DUP_B.omieId,
};

/**
 * Returns a deep clone of the mock Omie dataset so callers cannot mutate the catalog.
 *
 * @returns Fresh copies of clients, service orders, products, vehicle identifiers, and duplicate pairs.
 */
export function mockOmieDataset() {
  return structuredClone({
    clients: [LINKED, MATCHABLE, DUP_A, DUP_B],
    serviceOrders: [SERVICE],
    products: [PRODUCT, TECFIL_OIL_FILTER_PRODUCT, TECFIL_FUEL_FILTER_PRODUCT],
    vehicleIds: [VEHICLE],
    duplicatePairs: [DUPLICATE],
  });
}
