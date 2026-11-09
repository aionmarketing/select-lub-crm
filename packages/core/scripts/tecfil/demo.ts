/**
 * CLI smoke script: resolves the fixed PEUGEOT / 207 / 2011 / 1.4 8V sample
 * against the **live** Tecfil catalogue (no picker — every field matches
 * exactly) and prints the fitted candidates plus the grid column(s) each
 * came from, so a re-ordered grid shows up as a wrong demo run rather than a
 * silently wrong price (design D3). Needs network access; excluded from CI.
 */

import { resolveFilters } from "../../src/kernel/clients/tecfil/resolver.js";

const result = await resolveFilters({
  make: "PEUGEOT",
  year: "2011",
  model: "207",
  version: "1.4 8V",
});

console.log(JSON.stringify(result, null, 2));

if (result.status === "ok") {
  console.log(`\nApplication: ${result.fitment.manufacturerLabel} / ${result.fitment.vehicleLabel} / ${result.fitment.engineLabel ?? "(unanimous — no specific engine)"}`);
  console.log(`Matched by: ${JSON.stringify(result.fitment.matchedBy)}`);
  for (const [label, candidates] of [
    ["Oil filter", result.fitment.oilFilters],
    ["Fuel filter", result.fitment.fuelFilters],
  ] as const) {
    console.log(`\n${label} candidates:`);
    for (const c of candidates) {
      console.log(`  ${c.partNumber} (from ${c.sourceColumns.join(", ")}) — ${c.description}`);
      for (const xref of c.crossReferences) {
        console.log(`    cross-ref: ${xref.brand} ${xref.partNumber}`);
      }
    }
  }
} else {
  console.log(`\nNot ok: ${result.status}`);
}
