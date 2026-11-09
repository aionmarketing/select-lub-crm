/**
 * TypeScript shapes for JSON returned by Motul Oil Advisor (`gateway-apim.motul.com/oil-advisor`, locale pt-BR).
 */

/**
 * Row from `vehicle-brands` (`getVehicleBrands`).
 * @example
 * {
 *   id: "eyJpZCI6ImV5SnBaQ0k2TXpBeExDSmpJam9pTVNKOSIsInByb3ZpZGVySWQiOjF9",
 *   name: "PEUGEOT",
 *   years: ["2011", "2010", "2009", "2008", ...]
 * }
 */
export type VehicleBrand = {
  id: string;
  name: string;
  years: string[];
};

/**
 * Row from `vehicle-models` (`getVehicleModels`).
 * @example
 * {
 *   id: "eyJpZCI6ImV5SnBaQ0k2TnprMk5pd2lZeUk2SWpFaUxDSjVJam9pTWpBeE1TSjkiLCJwcm92aWRlcklkIjoxfQ",
 *   name: "207 / Passion / SW"
 * }
 */
export type VehicleModel = {
  id: string;
  name: string;
};

/**
 * Row from `vehicle-types` (`getSubModels`).
 * @example
 * {
 *   id: "eyJpZCI6ImV5SnBaQ0k2TVRJek9UY3NJbU1pT2lJeElpd2liU0k2TnprMk5pd2llU0k2SWpJd01URWlmUSIsInByb3ZpZGVySWQiOjF9",
 *   name: "1.4i 8V - TU3"
 * }
 */
export type SubModel = {
  id: string;
  name: string;
};

/**
 * Usage or mileage option on recommendation payloads.
 * @example
 * { default: true, label: "Normal", comments: [] }
 * @example
 * { default: true, label: "-150 000km", comments: [] }
 */
type ConditionOption = {
  default: boolean;
  label: string;
  comments: string[];
};

/**
 * Title/value field pair used throughout product `normalizedData`.
 * @example
 * { title: "viscosity", value: "5W-40" }
 */
type LabeledField = { title: string; value: string };

/**
 * SKU-level variant row inside `normalizedData.variants`.
 * @example
 * {
 *   quantity: { title: "quantity", value: "1L" },
 *   engineType: { title: "engineType", value: "4T" },
 *   productType: { title: "productType", value: "8100" },
 *   quality: { title: "quality", value: "" },
 *   viscosity: { title: "viscosity", value: "5W-40" },
 *   application: { title: "application", value: "Motor" },
 *   segment: { title: "segment", value: "Auto" },
 *   sku: { title: "sku", value: "109774" },
 *   ean: { title: "ean", value: "3374650296517" }
 * }
 */
type ProductVariant = {
  quantity: LabeledField;
  engineType: LabeledField;
  productType: LabeledField;
  quality: LabeledField;
  viscosity: LabeledField;
  application: LabeledField;
  segment: LabeledField;
  sku: LabeledField;
  ean: LabeledField;
};

/**
 * Nested product payload under `RecommendedProduct.details`.
 * @example
 * {
 *   normalizedData: {
 *     name: { title: "name", value: "MOTUL 8100 X-CESS GEN2 5W-40" },
 *     emg: { title: "emg", value: "17603" },
 *     description: { title: "description", value: "Lubrificante de alto desempenho..." },
 *     apiStandards: { title: "apiStandards", value: "" },
 *     aceaStandards: { title: "aceaStandards", value: "ACEA A3/B4, API SERVICE SQ" },
 *     quantities: { title: "quantities", value: ["1L", "4L", "20L"] },
 *     upsell: ["13311"],
 *     variants: [{ quantity: { title: "quantity", value: "1L" }, ... }],
 *     defaultVariant: { quantity: { title: "quantity", value: "1L" }, ... },
 *     usp: [],
 *     howToUseImages: []
 *   },
 *   gallery: {
 *     "109774": [{
 *       id: "https://azupim01.motul.com/media/.../motul_109774_...png",
 *       src: "https://azupim01.motul.com/media/.../motul_109774_...png",
 *       mediaType: "image",
 *       alt: "MOTUL 8100 X-CESS GEN2 5W-40 - SKU 109774"
 *     }]
 *   }
 * }
 */
type ProductDetails = {
  normalizedData: {
    name: LabeledField;
    emg: LabeledField;
    description: LabeledField;
    apiStandards: LabeledField;
    jasoStandards: LabeledField;
    aceaStandards: LabeledField;
    approvals: LabeledField;
    performances: LabeledField;
    recommendations: LabeledField;
    safetyDataSheetLanguages: string[];
    technicalDataSheetHref: LabeledField;
    quantities: { title: string; value: string[] };
    upsell: string[];
    variants: ProductVariant[];
    defaultVariant: ProductVariant;
    usp: unknown[];
    howToUseImages: unknown[];
  };
  gallery: Record<
    string,
    { id: string; src: string; mediaType: string; alt: string }[]
  >;
};

/**
 * Product row inside a mileage-band recommendation entry.
 * @example
 * {
 *   name: "MOTUL 8100 X-CESS GEN2 5W-40",
 *   emg: "17603",
 *   apporder: "4",
 *   recommendationCategory: {
 *     title: "SPECIALIST",
 *     description: "A melhor recomendação, de um especialista em lubrificantes..."
 *   },
 *   providerData: { motulExpertObservation: null },
 *   pictureUrl: "https://azupim01.motul.com/media/motulData/IM/bigweb/motul_109774_...png",
 *   details: { normalizedData: { ... }, gallery: { ... } }
 * }
 * @example
 * // `motulExpertObservation` references a legend key when present (e.g. "A" → extraData.motulExpertLegends.a)
 * { providerData: { motulExpertObservation: "A" } }
 */
export type RecommendedProduct = {
  name: string;
  emg: string;
  apporder: string;
  recommendationCategory: { title: string; description: string };
  providerData: { motulExpertObservation: string | null };
  pictureUrl: string;
  details: ProductDetails;
};

/**
 * One mileage/usage band inside a component's `recommendations` array.
 * @example
 * {
 *   conditions: { usage: "Normal", mileage: "-150 000km" },
 *   products: [{ name: "MOTUL 8100 X-CESS GEN2 5W-40", emg: "17603", ... }],
 *   upsell: {
 *     emg: "13311",
 *     name: "MOTUL 300V COMPETITION 5W-40",
 *     pictureUrl: "https://azupim01.motul.com/media/.../Motul_110817_...png",
 *     details: { normalizedData: { ... }, gallery: { ... } }
 *   }
 * }
 */
export type MotulRecommendationEntry = {
  conditions: { usage: string; mileage: string };
  products: RecommendedProduct[];
  upsell?: Pick<RecommendedProduct, "emg" | "name" | "pictureUrl" | "details">;
};

/**
 * Engine, transmission, or other lubricated component on a vehicle recommendation.
 * @example
 * // Engine
 * {
 *   capacities: [{ label: "3,00" }],
 *   category: { code: "", name: "motor" },
 *   recommendations: [{ conditions: { usage: "Normal", mileage: "-150 000km" }, products: [...] }],
 *   conditions: { usage: [{ default: true, label: "Normal", comments: [] }] }
 * }
 * @example
 * // Non-engine part
 * {
 *   capacities: [{ label: "1,90" }],
 *   category: { code: "", name: "transmissão, manual - 5 marchas" },
 *   recommendations: [{ conditions: { usage: "Normal", mileage: "-150 000km" }, products: [...] }],
 *   conditions: { usage: [{ default: true, label: "Normal", comments: [] }] }
 * }
 */
export type MotulComponent = {
  capacities: { label: string }[];
  category: { code: string; name: string };
  recommendations: MotulRecommendationEntry[];
  conditions: {
    usage: ConditionOption[];
  };
};

/**
 * Full recommendation payload from `recommendations` (`getOilRecommendation`).
 * `brand` is usually empty — pass the resolved catalog brand name downstream.
 * @example
 * {
 *   categoryId: "CAR",
 *   brand: "",
 *   type: "1.4i 8V - TU3",
 *   model: "207 / Passion / SW",
 *   startYear: "2011",
 *   endYear: "2011",
 *   extraData: {
 *     motulExpertLegends: {
 *       a: "Somente para uso em veículos fora de garantia de fábrica.",
 *       d: "Volume em serviço.",
 *       ...
 *     }
 *   },
 *   components: [{ category: { name: "motor" }, ... }, { category: { name: "transmissão, manual - 5 marchas" }, ... }],
 *   conditions: {
 *     mileage: [
 *       { default: true, label: "-150 000km", comments: [] },
 *       { default: false, label: "+150 000km", comments: [] }
 *     ]
 *   }
 * }
 */
export type MotulRecommendation = {
  categoryId: string;
  brand: string;
  type: string;
  model: string;
  startYear: string;
  endYear: string;
  extraData: {
    motulExpertLegends: Record<string, string>;
  };
  components: MotulComponent[];
  conditions: {
    mileage: ConditionOption[];
  };
};
