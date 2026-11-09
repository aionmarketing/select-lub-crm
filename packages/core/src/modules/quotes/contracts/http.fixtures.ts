/**
 * Typed sample records for tests and UI mocks; values satisfy the production Zod schemas.
 *
 * Moved from `packages/shared-types/src/fixtures.ts` (5.1d) with declarations unchanged.
 */
import { customerFixture, vehicleFixture } from "../../customers/contracts/http.js";
import type { CatalogItem, FilterDetail, LubricantDetail } from "./http.catalog.js";
import type { MotulCompatibility } from "./http.motul-compatibility.js";
import type { OilQuote, QuoteOptionsResult } from "./http.oil-quote.js";
import type { TecfilCompatibility } from "./http.tecfil-compatibility.js";

const timestamps = {
  createdAt: "2026-08-21T10:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

/**
 * Sample verified-spec cache row for a Peugeot 207 used in quote-builder tests. The two SAE
 * grades exercise the "offer a card for every listed grade" rule; the liters are service fill,
 * so `89.9 × 3.5` is a subtotal no single catalog price could coincidentally equal.
 */
export const motulCompatibilityFixture = {
  id: "motul-1",
  make: "PEUGEOT",
  year: 2011,
  model: "207 Passion SW",
  version: "1.4i 8V - TU3",
  viscosityGrades: ["5W-40", "5W-30"],
  viscosity: "5W-40",
  classification: "API SN",
  fillLiters: 3.5,
  fillKind: "em_servico",
  consultedAt: "2026-08-20T15:00:00.000Z",
  rawPayload: null,
  sourcePublisher: "Peugeot do Brasil",
  sourceDocument: "Manual do Proprietário 207 (2011)",
  sourcePage: "Seção 8 — Capacidades",
} satisfies MotulCompatibility;

/** Sample active catalog row priced for quote tests; its oil spec is `lubricantDetailFixture`. */
export const catalogItemFixture = {
  id: "cat-1",
  brand: "Motul",
  description: "8100 X-cess",
  price: 89.9,
  stock: 0,
  active: true,
  ...timestamps,
} satisfies CatalogItem;

/** Oil spec making `catalogItemFixture` a lubricant, with viscosity, classification and oil type set. */
export const lubricantDetailFixture = {
  catalogItemId: catalogItemFixture.id,
  viscosity: "5W-40",
  classification: "API SN",
  oilType: "SINTETICO",
} satisfies LubricantDetail;

/** Sample inactive catalog row used to assert inactive products can still appear on saved quotes. */
export const inactiveCatalogItemFixture = {
  id: "cat-inactive",
  brand: "Lubrax",
  description: "Essencial",
  price: 120,
  stock: 0,
  active: false,
  ...timestamps,
} satisfies CatalogItem;

/** Sample oil-change quote referencing `inactiveCatalogItemFixture` for price-snapshot tests. */
export const oilQuoteFixture = {
  id: "quote-1",
  customerId: customerFixture.id,
  vehicleId: vehicleFixture.id,
  conversationId: null,
  lines: [
    {
      catalogItemId: inactiveCatalogItemFixture.id,
      brand: inactiveCatalogItemFixture.brand,
      description: inactiveCatalogItemFixture.description,
      price: 99.9,
    },
  ],
  generatedMessageText:
    "Troca de óleo Lubrax Essencial 15W-40 por R$ 99,90.",
  createdBy: "user-1",
  ...timestamps,
} satisfies OilQuote;

/**
 * Sample Tecfil cache row for the same Peugeot 207 as `motulCompatibilityFixture`, taken
 * from the 2026-09-03 probe. The engine came from unanimity, so `application.engine` is
 * null; the oil candidate carries the Authomix cross-reference that gives the oil type two
 * catalog candidates and therefore a chooser.
 */
export const tecfilCompatibilityFixture = {
  id: "tecfil-1",
  make: motulCompatibilityFixture.make,
  year: motulCompatibilityFixture.year,
  model: motulCompatibilityFixture.model,
  version: motulCompatibilityFixture.version,
  application: {
    manufacturer: "PEUGEOT",
    vehicle: "207",
    engine: null,
  },
  matchedBy: {
    manufacturer: "exact",
    vehicle: "picked",
    engine: "unanimous",
  },
  oilFilters: [
    {
      tecfilNumber: "PEL108",
      tecfilProductCode: 1108,
      description: "Filtro de Oleo Lubrificante",
      crossReferences: [{ brand: "AUTHOMIX", number: "FOL0108" }],
    },
  ],
  fuelFilters: [
    {
      tecfilNumber: "GI50/7",
      tecfilProductCode: 5007,
      description: "Filtro de Combustivel",
      crossReferences: [],
    },
  ],
  consultedAt: "2026-09-03T18:00:00.000Z",
  rawPayload: null,
} satisfies TecfilCompatibility;

/** Sample active oil-filter catalog row; its fitment key is `filterDetailFixture`. */
export const filterCatalogItemFixture = {
  id: "cat-tecfil-pel108",
  brand: "Tecfil",
  description: "Filtro de óleo PEL108",
  price: 32,
  stock: 0,
  active: true,
  ...timestamps,
} satisfies CatalogItem;

/** Fitment key making `filterCatalogItemFixture` an oil filter. */
export const filterDetailFixture = {
  catalogItemId: filterCatalogItemFixture.id,
  filterType: "OLEO",
  partNumber: "PEL108",
} satisfies FilterDetail;

/**
 * Sample `options` payload whose oil filter resolved to one candidate and whose fuel filter
 * found no catalog item, so both the priced path and a warning path are exercised.
 */
export const quoteOptionsWithFiltersFixture = {
  status: "options",
  viscosityGrades: motulCompatibilityFixture.viscosityGrades,
  viscosity: lubricantDetailFixture.viscosity,
  classification: lubricantDetailFixture.classification,
  fillLiters: motulCompatibilityFixture.fillLiters,
  fillKind: motulCompatibilityFixture.fillKind,
  fillCondition: "with_filter",
  sourcePublisher: motulCompatibilityFixture.sourcePublisher,
  sourceDocument: motulCompatibilityFixture.sourceDocument,
  sourcePage: motulCompatibilityFixture.sourcePage,
  gradeSources: motulCompatibilityFixture.viscosityGrades.map((grade) => ({
    grade,
    sourcePublisher: motulCompatibilityFixture.sourcePublisher,
    sourceDocument: motulCompatibilityFixture.sourceDocument,
    sourcePage: motulCompatibilityFixture.sourcePage,
    sourceAuthority: null,
    sourceUrl: null,
  })),
  litersSource: {
    sourcePublisher: motulCompatibilityFixture.sourcePublisher,
    sourceDocument: motulCompatibilityFixture.sourceDocument,
    sourcePage: motulCompatibilityFixture.sourcePage,
    sourceAuthority: null,
    sourceUrl: null,
  },
  consultedAt: motulCompatibilityFixture.consultedAt,
  options: [{ ...catalogItemFixture, lubricant: lubricantDetailFixture }],
  filters: {
    source: "cached",
    consultedAt: tecfilCompatibilityFixture.consultedAt,
    application: tecfilCompatibilityFixture.application,
    oil: {
      status: "matched",
      candidates: [{ ...filterCatalogItemFixture, filter: filterDetailFixture }],
    },
    fuel: { status: "no_catalog_match", tecfilNumbers: ["GI50/7"] },
  },
} satisfies QuoteOptionsResult;

/**
 * Sample `no_capacity` payload (background-oil-research D24): the grades verified, no usable
 * liters, and the offerable cards and filters for the client to price from a typed volume.
 */
export const noCapacityWithCardsFixture = {
  status: "no_capacity",
  viscosityGrades: quoteOptionsWithFiltersFixture.viscosityGrades,
  viscosity: quoteOptionsWithFiltersFixture.viscosity,
  classification: quoteOptionsWithFiltersFixture.classification,
  consultedAt: quoteOptionsWithFiltersFixture.consultedAt,
  options: quoteOptionsWithFiltersFixture.options,
  filters: quoteOptionsWithFiltersFixture.filters,
} satisfies QuoteOptionsResult;

/** A disputed card's source: a tier 1 manufacturer manual, with its URL and class. */
const manualConflictSource = {
  sourcePublisher: "Toyota",
  sourceDocument: "Manual do proprietário Corolla 2019",
  sourcePage: "p. 412",
  sourceAuthority: 1,
  sourceUrl: "https://toyota.com.br/manual-corolla-2019.pdf",
  sourceClassification: "manufacturer_manual",
} as const;

/** A disputed card's source: a local catalog fixture, with no URL and no class. */
const catalogConflictSource = {
  sourcePublisher: "CarroRac",
  sourceDocument: "Tabela de aplicação",
  sourcePage: "Corolla 2019",
  sourceAuthority: 5,
  sourceUrl: null,
  sourceClassification: null,
} as const;

/**
 * Sample `conflicting_sources` with its card data (D24 F1): the manual lists `0W-20`, the catalog
 * the fixture's stocked grade; both at 4,0 L, so the volume is agreed.
 */
export const gradeConflictWithCardsFixture = {
  status: "conflicting_sources",
  conflicts: [
    {
      field: "viscosityGrades",
      values: [
        { value: "0W-20", sourcePublisher: "Toyota", sourceDocument: "Manual do proprietário Corolla 2019", sourcePage: "p. 412", sourceAuthority: 1 },
        { value: lubricantDetailFixture.viscosity, sourcePublisher: "CarroRac", sourceDocument: "Tabela de aplicação", sourcePage: "Corolla 2019", sourceAuthority: 5 },
      ],
    },
  ],
  viscosityGrades: ["0W-20", lubricantDetailFixture.viscosity],
  classification: "",
  gradeSources: [
    { grade: "0W-20", ...manualConflictSource },
    { grade: lubricantDetailFixture.viscosity, ...catalogConflictSource },
  ],
  options: [{ ...catalogItemFixture, lubricant: lubricantDetailFixture, gradeSource: catalogConflictSource }],
  filters: quoteOptionsWithFiltersFixture.filters,
  fillLiters: 4,
  fillKind: "em_servico",
  fillCondition: "with_filter",
  litersSource: manualConflictSource,
} satisfies QuoteOptionsResult;

/**
 * Sample `conflicting_sources` on the volume (D24 F2): both sources list the stocked grade, the
 * manual states 4,3 L and the catalog 4,0 L, so each is a choice, highest authority first.
 */
export const volumeConflictWithCardsFixture = {
  status: "conflicting_sources",
  conflicts: [
    {
      field: "fillLiters",
      values: [
        { value: "4.3", sourcePublisher: "Toyota", sourceDocument: "Manual do proprietário Corolla 2019", sourcePage: "p. 412", sourceAuthority: 1 },
        { value: "4", sourcePublisher: "CarroRac", sourceDocument: "Tabela de aplicação", sourcePage: "Corolla 2019", sourceAuthority: 5 },
      ],
    },
  ],
  viscosityGrades: [lubricantDetailFixture.viscosity],
  classification: "",
  gradeSources: [{ grade: lubricantDetailFixture.viscosity, ...manualConflictSource }],
  options: [{ ...catalogItemFixture, lubricant: lubricantDetailFixture, gradeSource: manualConflictSource }],
  filters: quoteOptionsWithFiltersFixture.filters,
  volumeChoices: [
    { liters: 4.3, fillCondition: "with_filter", source: manualConflictSource },
    { liters: 4, fillCondition: "unlabeled", source: catalogConflictSource },
  ],
} satisfies QuoteOptionsResult;
