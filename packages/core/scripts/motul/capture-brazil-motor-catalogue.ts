/**
 * One-shot live capture of Motul Brazil motor products. Sequential with pauses. Not CI.
 *
 *   pnpm --filter @select-lub/core motul:capture-brazil-motor-catalogue
 *
 * Catalogue: POST product-catalogue/search-products (application=motor).
 * Detail: GET motul.com/_next/data/.../products/{id}.json — no cookies.
 * Stop on a 429 that survives one 60s wait. Do not run alongside other Motul traffic.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PAUSE_PAGE_MS = 3_000;
const PAUSE_DETAIL_MS = 8_000;
const WAIT_429_MS = 60_000;
const PAGE_SIZE = 12;
const CATALOGUE_URL = "https://gateway-apim.motul.com/product-catalogue/search-products";
const NEXT_BUILD_ID = "jjDx7jwTrBaEzmsF0ULhM";
const OUT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/kernel/clients/motul",
  "captures",
  "brazil-motor-catalogue.json",
);

const SEARCH_BODY = {
  parameters: [
    { key: "keyword", value: "" },
    { key: "country", value: "Brazil" },
  ],
  api: "PWA",
  includeLocale: true,
  count: PAGE_SIZE,
  offset: 0,
  filters: {
    advancedFilters: [
      { category: "application", filters: ["motor"] },
      { category: "engine_type", filters: [] },
      { category: "product_type", filters: [] },
      { category: "quality", filters: [] },
      { category: "viscosity", filters: [] },
    ],
  },
  locale: "pt-BR",
  context: [{ key: "country", value: "Brazil" }],
  returnTotalResults: true,
};

type CatalogueProduct = {
  productId: string;
  productTitle: string;
  productTags: unknown[];
  productQuantities: unknown[];
  productImage: string;
  productSegment: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pause(reason: string, ms: number) {
  console.log(`${new Date().toISOString()} pause ${ms}ms — ${reason}`);
  await sleep(ms);
}

function labeledValue(field: unknown): string | null {
  if (!field || typeof field !== "object") {
    return null;
  }
  const value = (field as { value?: unknown }).value;
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(String).join(", ");
  }
  return null;
}

function slimVariant(row: unknown) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const variant = row as Record<string, unknown>;
  return {
    quantity: labeledValue(variant.quantity),
    engineType: labeledValue(variant.engineType),
    productType: labeledValue(variant.productType),
    quality: labeledValue(variant.quality),
    viscosity: labeledValue(variant.viscosity),
    application: labeledValue(variant.application),
    segment: labeledValue(variant.segment),
    sku: labeledValue(variant.sku),
    ean: labeledValue(variant.ean),
  };
}

function slimProductData(productData: Record<string, unknown>) {
  const variants = Array.isArray(productData.variants)
    ? productData.variants.map(slimVariant).filter((row) => row !== null)
    : [];
  return {
    name: labeledValue(productData.name),
    emg: labeledValue(productData.emg),
    description: labeledValue(productData.description),
    apiStandards: labeledValue(productData.apiStandards),
    jasoStandards: labeledValue(productData.jasoStandards),
    aceaStandards: labeledValue(productData.aceaStandards),
    approvals: labeledValue(productData.approvals),
    performances: labeledValue(productData.performances),
    recommendations: labeledValue(productData.recommendations),
    technicalDataSheetHref: labeledValue(productData.technicalDataSheetHref),
    quantities: Array.isArray((productData.quantities as { value?: unknown })?.value)
      ? (productData.quantities as { value: unknown[] }).value
      : [],
    defaultVariant: slimVariant(productData.defaultVariant),
    variants,
  };
}

async function searchPage(offset: number): Promise<{ products: CatalogueProduct[]; total: number; status: number }> {
  const res = await fetch(CATALOGUE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: "https://www.motul.com",
      Referer: "https://www.motul.com/",
    },
    body: JSON.stringify({ ...SEARCH_BODY, offset }),
  });
  if (!res.ok) {
    return { products: [], total: 0, status: res.status };
  }
  const body = (await res.json()) as { products?: CatalogueProduct[]; total?: number };
  return {
    products: body.products ?? [],
    total: body.total ?? 0,
    status: res.status,
  };
}

async function fetchDetail(id: string): Promise<{ status: number; productData: ReturnType<typeof slimProductData> | null }> {
  const url = `https://www.motul.com/_next/data/${NEXT_BUILD_ID}/pt-BR/products/${id}.json?id=${id}`;
  const res = await fetch(url, {
    headers: {
      accept: "*/*",
      referer: "https://www.motul.com/pt-BR/products?application=motor",
      "x-nextjs-data": "1",
    },
  });
  if (res.status === 429) {
    return { status: 429, productData: null };
  }
  if (!res.ok) {
    return { status: res.status, productData: null };
  }
  const body = (await res.json()) as { pageProps?: { productData?: Record<string, unknown> } };
  const productData = body.pageProps?.productData;
  if (!productData) {
    return { status: res.status, productData: null };
  }
  return { status: res.status, productData: slimProductData(productData) };
}

async function fetchDetailWith429Retry(id: string) {
  const first = await fetchDetail(id);
  if (first.status !== 429) {
    return first;
  }
  console.log("429 on product detail — waiting once");
  await pause("429 Retry-After fallback", WAIT_429_MS);
  return fetchDetail(id);
}

async function main() {
  const listed: CatalogueProduct[] = [];
  // Declared here (uninitialized, not `= 0`) because it is read after the loop for
  // catalogueTotal below; every exit path that falls through to that read assigns it first.
  let total: number;
  let offset = 0;
  while (true) {
    if (offset > 0) {
      await pause(`catalogue offset ${offset}`, PAUSE_PAGE_MS);
    }
    const page = await searchPage(offset);
    if (page.status === 429) {
      console.error("catalogue 429 — aborting");
      process.exitCode = 1;
      return;
    }
    if (page.status !== 200) {
      console.error(`catalogue HTTP ${page.status} at offset ${offset}`);
      process.exitCode = 1;
      return;
    }
    total = page.total;
    listed.push(...page.products);
    console.log(`catalogue offset=${offset} got ${page.products.length} total=${total}`);
    offset += PAGE_SIZE;
    if (listed.length >= total || page.products.length === 0) {
      break;
    }
  }

  const lubricants: {
    productId: string;
    productTitle: string;
    productSegment: string;
    productImage: string;
    detailStatus: number;
    productData: ReturnType<typeof slimProductData> | null;
  }[] = [];
  let stopped: string | undefined;

  for (let index = 0; index < listed.length; index += 1) {
    const row = listed[index]!;
    if (index > 0) {
      await pause(`between product ${index} and ${index + 1}`, PAUSE_DETAIL_MS);
    }
    const detail = await fetchDetailWith429Retry(row.productId);
    const viscosity = detail.productData?.defaultVariant?.viscosity ?? null;
    console.log(
      `${index + 1}/${listed.length} ${row.productId} HTTP ${detail.status} ${viscosity ?? "no viscosity"} ${row.productTitle}`,
    );
    lubricants.push({
      productId: row.productId,
      productTitle: row.productTitle,
      productSegment: row.productSegment,
      productImage: row.productImage,
      detailStatus: detail.status,
      productData: detail.productData,
    });
    if (detail.status === 429) {
      stopped = "429 after retry";
      break;
    }
  }

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(
    OUT_PATH,
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        locale: "pt-BR",
        country: "Brazil",
        application: "motor",
        nextBuildId: NEXT_BUILD_ID,
        catalogueTotal: total,
        listed: listed.length,
        captured: lubricants.length,
        stopped,
        lubricants,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote ${OUT_PATH} ${lubricants.length}/${listed.length} stopped=${stopped ?? "no"}`);
}

await main();
