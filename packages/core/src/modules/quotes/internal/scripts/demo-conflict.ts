/**
 * Manual showcase of conflict detection and escalation (script; never in `pnpm test`).
 *
 * Run: `pnpm --filter @select-lub/api demo:oil-conflict`
 *
 * Two REAL rows from the same CarroRac page, both for "Polo AW (2017-2026)", handed to a
 * quote for a `Polo 2021 1.0 TSI`: the `1.0 TSI (70 kW)` row (4 L) and the `1.0 MPI (55 kW)`
 * row (3,4 L). Same publisher, same tier 5, different engines. This is what a misfiled
 * catalog row looks like in practice — every value below was really on that page; only the
 * misattribution is staged, and it is the realistic failure.
 *
 * What a live run actually shows (2026-09-09): NOT the conflict path. The engine-coverage
 * check (D15) fires first — the model, handed the MPI row for a TSI car, answers `mismatch`, and
 * the pipeline stops at `needs_clarification` before any comparison. That is the cheaper
 * guard catching the misfiled row ahead of the dearer one, and it is the right order. Two
 * sources can only *conflict* when both describe the same engine, and this repo holds one
 * real publisher; the conflict and escalation paths are proven by the fakes in
 * oil-spec.test.ts, not here. Pass 2 still exercises the real escalator wiring end to end
 * whenever a future pair of same-engine sources disagrees.
 */
import { createOilSpecExtractor, resolveOilSpec } from "../pipeline/oil-spec.js";
import type { RetrievedSource } from "../pipeline/oil-spec.js";
import { createEscalationExtractor, createModelOilSpecExtractor } from "../pipeline/spec-extractor.js";
import { researchModel } from "../model-calls/research-model.js";
import type { VehicleIdentity } from "../store/store.js";

const identity: VehicleIdentity = { make: "Volkswagen", year: 2021, model: "Polo", version: "1.0 TSI" };

function row(page: string, text: string): RetrievedSource {
  return {
    publisher: "CarroRac",
    document: "Óleo de motor Volkswagen Polo — tabela de aplicação",
    page,
    authority: 5,
    url: "https://carrorac.com/oleo-motor/volkswagen/polo.html",
    content: { kind: "text", text },
  };
}

const tsiRow = row(
  "Polo AW (2017-2026), 1.0 TSI (70 kW)",
  "Polo AW (2017-2026)\n1.0 TSI (70 kW)\nViscosidade recomendada: 0W-20, 5W-40, 0W-40, 5W-30\nCapacidade 4 litro (Preenchimento de serviço)",
);
const mpiRow = row(
  "Polo AW (2017-2026), 1.0 MPI (55 kW)",
  "Polo AW (2017-2026)\n1.0 MPI (55 kW)\nViscosidade recomendada: 0W-20, 5W-40, 0W-40, 5W-30\nCapacidade 3,4 litro (Preenchimento de serviço)",
);

const retrieve = async () => ({ status: "found" as const, sources: [mpiRow, tsiRow] });
const extract = createOilSpecExtractor(createModelOilSpecExtractor());

function print(label: string, result: Awaited<ReturnType<typeof resolveOilSpec>>) {
  console.log(`\n${"=".repeat(72)}\n${label}\n${"=".repeat(72)}`);
  console.log(`status: ${result.status}`);
  if (result.status === "needs_clarification") {
    console.log(`  motores nomeados pela passagem recusada: ${result.options.join(" | ") || "(nenhum listado)"}`);
    console.log("  → a conferência de motor (D15) barrou antes de qualquer comparação; cards: nenhum");
  }
  if (result.status === "conflicting_sources") {
    for (const conflict of result.conflicts) {
      console.log(`  ${conflict.field}:`);
      for (const entry of conflict.values) {
        console.log(`    ${entry.value}  ← ${entry.citation.publisher}, ${entry.citation.page} (autoridade ${entry.citation.authority})`);
      }
    }
    console.log("  cards: nenhum");
  } else if (result.status === "verified") {
    console.log(`  viscosidades: ${result.viscosityGrades.join(", ")}`);
    console.log(`  litros: ${result.fillLiters} L (${result.fillKind})`);
    console.log(`  citação: ${result.citation.page}`);
    console.log(`  resolvido pela escalação: ${result.settledByEscalation === true}`);
  }
}

print("PASSO 1 — sem escalação configurada", await resolveOilSpec(identity, { retrieve, extract }));

print(
  `PASSO 2 — com escalação (${researchModel().escalationModel}, effort ${researchModel().escalationEffort ?? "none"})`,
  await resolveOilSpec(identity, { retrieve, extract, escalate: createEscalationExtractor() }),
);
