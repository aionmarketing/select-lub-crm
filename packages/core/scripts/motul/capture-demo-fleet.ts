/**
 * One-shot live Motul capture for two plate-hit passenger cars. Sequential with
 * pauses. Not CI.
 *
 *   pnpm --filter @select-lub/core motul:capture-demo-fleet
 *
 * Identities come from the APIBrasil probe (Polo 2014 FKW0812, HR-V 2021 FWR6183).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pickEngineFillLiters } from "../../src/kernel/clients/motul/pick-fill.js";
import { normalizeMotulName, resolveOil } from "../../src/kernel/clients/motul/resolver.js";

const PAUSE_MS = 8_000;
const WAIT_429_MS = 60_000;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../src/kernel/clients/motul", "captures");

type MotulCapture = {
  status: "ok" | "needs" | "unmatched" | "unavailable";
  field?: string;
  options?: string[];
  plate: string;
  make: string;
  year: number;
  model: string;
  version: string;
  viscosity?: string;
  classification?: string;
  fillLiters?: number;
  fillKind?: string;
  motorCapacities?: { volume: string; note?: string }[];
  productName?: string;
  pausedMsBefore: number;
  capturedAt: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pause(reason: string, ms: number) {
  console.log(`${new Date().toISOString()} pause ${ms}ms — ${reason}`);
  await sleep(ms);
}

async function captureOne(
  identity: { brand: string; year: string; model: string; submodel?: string; plate: string },
  pausedMsBefore: number,
): Promise<MotulCapture> {
  const capturedAt = new Date().toISOString();
  const base = {
    plate: identity.plate,
    make: identity.brand,
    year: Number(identity.year),
    model: identity.model,
    version: identity.submodel ?? "",
    pausedMsBefore,
    capturedAt,
  };
  console.log(`${capturedAt} Motul resolveOil`, identity);
  const result = await resolveOil({
    brand: identity.brand,
    year: identity.year,
    model: identity.model,
    submodel: identity.submodel,
  });
  if (result.status === "ok") {
    const motor =
      result.recommendation.parts.Motor ??
      result.recommendation.parts.motor ??
      Object.entries(result.recommendation.parts).find(([key]) => key.toLowerCase() === "motor")?.[1];
    const product = motor?.products?.[0] ?? motor?.byCondition?.[0]?.products?.[0];
    const fill = pickEngineFillLiters(result.recommendation);
    const viscosity = product?.name.match(/(\d+W-?\d+)/i)?.[1];
    return {
      ...base,
      status: "ok",
      viscosity,
      classification: product?.spec,
      fillLiters: fill?.liters,
      fillKind: fill?.kind,
      motorCapacities: motor?.capacities,
      productName: product?.name,
    };
  }
  return {
    ...base,
    status: result.status,
    field: "field" in result ? result.field : undefined,
    options: "options" in result ? result.options : undefined,
  };
}

async function captureWithUnavailableRetry(
  identity: { brand: string; year: string; model: string; submodel?: string; plate: string },
  pausedMsBefore: number,
): Promise<MotulCapture> {
  const first = await captureOne(identity, pausedMsBefore);
  if (first.status !== "unavailable") {
    return first;
  }
  console.log("Motul unavailable — waiting before a single retry (429 / gateway)");
  await pause("unavailable / possible 429", WAIT_429_MS);
  return captureOne(identity, WAIT_429_MS);
}

function pickSubmodel(options: string[] | undefined, hint?: string): string | undefined {
  if (!options || options.length === 0) {
    return undefined;
  }
  if (hint) {
    const needle = normalizeMotulName(hint);
    const hinted = options.find((name) => normalizeMotulName(name).includes(needle));
    if (hinted) {
      return hinted;
    }
  }
  return options[0];
}

async function resolveIdentity(input: {
  brand: string;
  year: string;
  model: string;
  plate: string;
  versionHint?: string;
}): Promise<MotulCapture> {
  const probe = await captureWithUnavailableRetry(
    { brand: input.brand, year: input.year, model: input.model, plate: input.plate },
    0,
  );
  console.log(JSON.stringify(probe, null, 2));
  if (probe.status === "ok" || probe.status === "unmatched" || probe.status === "unavailable") {
    return probe;
  }
  const sub = pickSubmodel(probe.options, input.versionHint);
  if (!sub) {
    return probe;
  }
  await pause(`between ${input.model} probe and full resolve`, PAUSE_MS);
  const full = await captureWithUnavailableRetry(
    {
      brand: input.brand,
      year: input.year,
      model: input.model,
      submodel: sub,
      plate: input.plate,
    },
    PAUSE_MS,
  );
  console.log(JSON.stringify(full, null, 2));
  return full;
}

async function main() {
  const polo = await resolveIdentity({
    brand: "VOLKSWAGEN",
    year: "2014",
    model: "Polo",
    plate: "FKW0812",
    versionHint: "1.6",
  });
  await pause("between Polo and HR-V Motul", PAUSE_MS);
  const hrv = await resolveIdentity({
    brand: "HONDA",
    year: "2021",
    model: "HR-V",
    plate: "FWR6183",
    versionHint: "EX CVT",
  });
  await mkdir(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, "motul.json");
  await writeFile(
    path,
    `${JSON.stringify({ capturedAt: new Date().toISOString(), identities: [polo, hrv] }, null, 2)}\n`,
  );
  console.log(`wrote ${path}`);
}

await main();
