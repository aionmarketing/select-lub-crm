/**
 * Manual showcase of the whole oil-quote path, by car model.
 *
 * Run it with `pnpm --filter @select-lub/api demo:oil-retrieval` (which loads the repo root
 * .env for OPENAI_API_KEY). It is a script, not a test: it makes a real model call for prose
 * sources, so it never runs in `pnpm test` or in `db:seed` (D8).
 *
 * It drives the runner's pipeline (`researchThenShow`: `resolveOilSpec`, then D10's mapping —
 * background-oil-research task 4.6; the quote route no longer runs one), then shows the row it
 * verified as the quote would, against the real Prisma store on the worktree's database (which
 * `db:seed` has given the production catalog). The whole
 * run happens inside one transaction that is rolled back at the end, so the showcase reads
 * the catalog but leaves no compatibility rows behind: a demo, never a seed (D8). Only
 * Tecfil is served from the committed capture rather than called live, so repeated runs do
 * not pound Catálogo Expresso. Everything printed is a value the pipeline actually produced.
 */
import {
  prisma,
  tecfilCaptureFixtures,
  type DbClient,
  type TecfilCaptureFilter,
} from "@select-lub/core/db";
import { createPrismaOilQuoteStore } from "../store/prisma.js";
import { createOilSpecExtractor } from "../pipeline/oil-spec.js";
import { researchThenShow } from "./research-then-show.js";
import { createModelOilSpecExtractor } from "../pipeline/spec-extractor.js";
import { createProductionRetriever } from "../retrieval/sources.js";
import type { TecfilFitmentLookup } from "../catalog/tecfil-lookup.js";

/** The demo fleet, spelled exactly as the seed stores these vehicles. */
const FLEET = [
  { make: "Volkswagen", year: 2021, model: "Polo", version: "1.0 TSI" },
  { make: "Honda", year: 2021, model: "HR-V", version: "EX CVT" },
  { make: "Fiat", year: 2021, model: "Argo", version: "1.0 Firefly" },
];

/** Formats an amount the way the dialog does. */
function brl(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** Maps a captured filter onto the shape the lookup port returns. */
function toCandidate(filter: TecfilCaptureFilter) {
  return {
    tecfilNumber: filter.partNumber,
    tecfilProductCode: filter.productCode,
    description: filter.description,
    crossReferences: filter.crossReferences.map((reference) => ({
      brand: reference.brand,
      number: reference.partNumber,
    })),
  };
}

/** Tecfil answers from the committed capture instead of the network. */
const capturedTecfil: TecfilFitmentLookup = async (identity) => {
  const row = tecfilCaptureFixtures().find(
    (capture) =>
      capture.make.toLowerCase() === identity.make.toLowerCase() &&
      capture.model.toLowerCase() === identity.model.toLowerCase() &&
      Number(capture.year) === identity.year,
  );
  if (!row?.fitment) {
    return { status: "unmatched", field: "engine" };
  }
  return {
    status: "ok",
    fitment: {
      application: {
        manufacturer: row.make.toUpperCase(),
        vehicle: row.model.toUpperCase(),
        engine: row.tecfilEngine ?? null,
      },
      matchedBy: { manufacturer: "exact", vehicle: "exact", engine: "picked" },
      oilFilters: row.fitment.oilFilters.map(toCandidate),
      fuelFilters: row.fitment.fuelFilters.map(toCandidate),
    },
  };
};

/** Thrown at the end of the showcase so the transaction rolls back; never a failure. */
class DemoRollback extends Error {}

/** Runs the showcase for every vehicle on one transaction-bound store. */
async function showcase(tx: DbClient): Promise<void> {
for (const identity of FLEET) {
  const label = `${identity.make} ${identity.model} ${identity.year} ${identity.version}`;
  console.log(`\n${"=".repeat(74)}\n${label}\n${"=".repeat(74)}`);

  const store = createPrismaOilQuoteStore(tx);

  const result = await researchThenShow(
    identity,
    {
      retrieve: createProductionRetriever(),
      extract: createOilSpecExtractor(createModelOilSpecExtractor()),
    },
    store,
    capturedTecfil,
    true,
  );

  if (result.status !== "options") {
    console.log(`status: ${result.status}`);
    if (result.status === "no_capacity" || result.status === "empty") {
      console.log(`  viscosidades verificadas: ${result.viscosityGrades.join(", ")}`);
    }
    if (result.status === "needs_clarification") {
      console.log(`  motores possíveis: ${result.options.join(" | ")}`);
    }
    if (result.status === "no_spec") {
      console.log("  nenhuma fonte citável para este veículo — sem cards, sem litros inventados");
    }
    continue;
  }

  console.log(`fonte:        ${result.sourcePublisher} — ${result.sourceDocument}`);
  console.log(`trecho em:    ${result.sourcePage}`);
  console.log(`viscosidades: ${result.viscosityGrades.join(", ")}`);
  console.log(`volume:       ${result.fillLiters} L (${result.fillKind})`);

  const oilSlot = result.filters.oil;
  const fuelSlot = result.filters.fuel;
  // A type with exactly one candidate is priced in; several show a chooser and contribute
  // nothing until the attendant picks — which is why a total below may omit a filter.
  const oilFilter =
    oilSlot.status === "matched" && oilSlot.candidates.length === 1 ? oilSlot.candidates[0]! : null;
  const fuelFilter =
    fuelSlot.status === "matched" && fuelSlot.candidates.length === 1 ? fuelSlot.candidates[0]! : null;
  const filtersTotal = (oilFilter?.price ?? 0) + (fuelFilter?.price ?? 0);

  if (oilSlot.status === "matched") {
    console.log(
      oilSlot.candidates.length === 1
        ? `filtro óleo:  ${oilFilter!.brand} ${oilFilter!.filter.partNumber} ${brl(oilFilter!.price)}`
        : `filtro óleo:  ${oilSlot.candidates.length} candidatos, o atendente escolhe — ${oilSlot.candidates
            .map((candidate) => `${candidate.brand} ${candidate.filter.partNumber} ${brl(candidate.price)}`)
            .join(" | ")}`,
    );
  } else {
    console.log(`filtro óleo:  ${oilSlot.status}`);
  }
  console.log(
    `filtro comb.: ${
      fuelFilter
        ? `${fuelFilter.brand} ${fuelFilter.filter.partNumber} ${brl(fuelFilter.price)}`
        : fuelSlot.status
    }`,
  );

  console.log(`\ncards (${result.options.length}):`);
  for (const card of result.options) {
    const subtotal = Math.round(card.price * result.fillLiters * 100) / 100;
    console.log(
      `  ${`${card.brand} ${card.description}`.padEnd(24)} [${card.lubricant.viscosity}] ` +
        `${brl(card.price)}/L × ${result.fillLiters} L = ${brl(subtotal)}` +
        `${filtersTotal > 0 ? ` + filtros ${brl(filtersTotal)} = ${brl(subtotal + filtersTotal)}` : ""}`,
    );
  }
}
}

if (!prisma) {
  throw new Error("demo-retrieval: DATABASE_URL must point at a worktree database (run db:worktree-env)");
}
const client = prisma;

try {
  await client.$transaction(
    async (tx) => {
      await showcase(tx);
      throw new DemoRollback("rolled back on purpose");
    },
    { timeout: 10 * 60_000, maxWait: 60_000 },
  );
} catch (error) {
  if (!(error instanceof DemoRollback)) throw error;
} finally {
  await client.$disconnect();
}
