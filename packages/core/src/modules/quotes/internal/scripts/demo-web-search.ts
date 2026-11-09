/**
 * Manual showcase of the web-search source adapter, by car model.
 *
 * Run it with `pnpm --filter @select-lub/api demo:oil-web-search` (which loads the repo root
 * .env for OPENAI_API_KEY). It is a script, not a test: it runs REAL
 * searches and REAL page fetches, so it never runs in `pnpm test` or in `db:seed` (D9).
 *
 * What it prints, per car, is the adapter's own structured log — every candidate the model
 * returned with the class it gave, its one-line reason, the tier code derived from that
 * class, and whether the page was accepted, blocked, or refused; then the accepted sources,
 * the manual candidates it deliberately did not open, and the quote the pipeline produced.
 *
 * The point of reading the output is task 8.2: judging the model's classifications by hand.
 * A page classified upward — a reseller calling itself a manufacturer manual — is exactly
 * what belongs in the blocklist, and this is where it becomes visible.
 */
import type { VehicleIdentity } from "../store/store.js";
import { createWebSearchRetriever, type WebSearchLog } from "../retrieval/web-search.js";
import { costUsdOf } from "../retrieval/search-cost.js";
import { createProductionRetriever } from "../retrieval/sources.js";
import { resolveOilSpec, createOilSpecExtractor } from "../pipeline/oil-spec.js";
import { createModelOilSpecExtractor } from "../pipeline/spec-extractor.js";

/**
 * The showcase fleet.
 *
 * The Polo is the control: a committed fixture already covers it at tier 1, so the gate must
 * skip the search entirely. The HR-V and the Argo are the real cases — the fixtures do not
 * cover them, so the web adapter is the only thing between them and a missed quote.
 */
const FLEET: VehicleIdentity[] = [
  { make: "Volkswagen", year: 2021, model: "Polo", version: "1.0 TSI" },
  { make: "Honda", year: 2021, model: "HR-V", version: "EX CVT" },
  { make: "Fiat", year: 2021, model: "Argo", version: "1.0 Firefly" },
];

/** Pause between cars, so a run of the whole fleet stays under the provider's TPM ceiling. */
const PACE_MS = 45_000;

type Spend = { input: number; cachedInput: number; reasoning: number; output: number; calls: number };
const fleetSpend: Spend = { input: 0, cachedInput: 0, reasoning: 0, output: 0, calls: 0 };

/**
 * Costs one search run. Reasoning tokens bill as output.
 *
 * @param spend - Accumulated token counts and billable search calls.
 * @returns USD.
 */
function usd(spend: Spend): number {
  // gpt-6.1-sol's list price plus the tool fee per search call (`costUsdOf`).
  return costUsdOf(spend, spend.calls);
}

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(22)} ${String(value)}`);
}

/** Prints one adapter run in the shape a reviewer reads it: candidate by candidate. */
function printLog(entry: WebSearchLog): void {
  for (const pass of entry.passes) {
    console.log(`\n  — search (${pass.model})`);
    console.log(`    query: ${pass.query}`);
    if (pass.candidates.length === 0) {
      console.log("    (the model returned no candidates)");
    }
    for (const candidate of pass.candidates) {
      console.log(`    ${candidate.outcome.toUpperCase()} — tier ${candidate.tier ?? "—"} — ${candidate.classification}`);
      console.log(`      ${candidate.url}`);
      console.log(`      motivo do modelo: ${candidate.reason}`);
    }
  }
  console.log("");
  line("fetched pages", entry.fetched);
  line("bytes of text", entry.bytes);
  line("elapsed ms", entry.elapsedMs);
  line("manual candidates", entry.manualCandidates);
  line("search calls", entry.searchCalls);
  if (entry.usage) {
    const spend: Spend = { ...entry.usage, calls: entry.searchCalls };
    line("tokens in", `${entry.usage.input} (+${entry.usage.cachedInput} cached)`);
    line("tokens out", `${entry.usage.output} (+${entry.usage.reasoning} reasoning)`);
    line("cost of this search", `US$ ${usd(spend).toFixed(5)}`);
    fleetSpend.input += entry.usage.input;
    fleetSpend.cachedInput += entry.usage.cachedInput;
    fleetSpend.reasoning += entry.usage.reasoning;
    fleetSpend.output += entry.usage.output;
    fleetSpend.calls += entry.searchCalls;
  } else {
    line("tokens", "(provider reported none)");
  }
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is empty — the search step would make no call. Nothing to show.");
    process.exitCode = 1;
    return;
  }

  const extract = createOilSpecExtractor(createModelOilSpecExtractor());

  let first = true;
  for (const identity of FLEET) {
    // Each car costs two searches with the web-search tool, and a tool call carries the
    // fetched pages back as tokens. Three cars back to back tripped the 200k tokens-per-
    // minute ceiling on the 2026-09-10 run and lost a whole escalation pass to a 429.
    if (!first) {
      await new Promise((resolve) => setTimeout(resolve, PACE_MS));
    }
    first = false;
    console.log(`\n${"=".repeat(78)}`);
    console.log(`${identity.make} ${identity.model} ${identity.year} ${identity.version}`);
    console.log("=".repeat(78));

    // First: the adapter on its own, so the classifications are visible even when the
    // gate would have skipped it.
    const entries: WebSearchLog[] = [];
    const adapter = createWebSearchRetriever({ log: (entry) => entries.push(entry) });
    const found = await adapter(identity);

    console.log(`\n[adapter alone] status: ${found.status}`);
    for (const entry of entries) {
      printLog(entry);
    }
    if (found.status === "found") {
      console.log("\n  accepted sources:");
      for (const source of found.sources) {
        console.log(`    tier ${source.authority ?? "—"} ${source.classification ?? "—"} — ${source.publisher}`);
        console.log(`      ${source.url ?? "(no url)"}`);
        console.log(`      "${source.page}"`);
      }
    }
    const manuals = found.status === "found" || found.status === "none" ? found.manualCandidates : undefined;
    if (manuals && manuals.length > 0) {
      console.log("\n  manual candidates (recorded, deliberately not opened — GitHub #77):");
      for (const manual of manuals) {
        console.log(`    tier ${manual.tier} ${manual.classification} — ${manual.url}`);
      }
    }

    // Then: the whole production pipeline, so the gate's decision and the final quote
    // status are visible too.
    const resolved = await resolveOilSpec(identity, {
      retrieve: createProductionRetriever(),
      extract,
    });
    console.log(`\n[full pipeline] status: ${resolved.status}`);
    if (resolved.status === "verified") {
      line("viscosities", resolved.viscosityGrades.join(" ou "));
      line("liters", `${resolved.fillLiters ?? "—"} (${resolved.fillKind ?? "—"})`);
      line("cited", `${resolved.citation.publisher} — ${resolved.citation.document}`);
      line("tier", resolved.citation.authority ?? "—");
      line("url", resolved.citation.url ?? "(local source)");
      line("classification", resolved.citation.classification ?? "(local source)");
      line("excerpt stored", resolved.citation.excerpt ? `${resolved.citation.excerpt.length} chars` : "no");
    }
    if (resolved.status === "needs_clarification") {
      line("engines", resolved.options.join(" | "));
    }
    if (resolved.status === "conflicting_sources") {
      for (const conflict of resolved.conflicts) {
        line(conflict.field, conflict.values.map((v) => `${v.value} (${v.citation.publisher})`).join(" vs "));
      }
    }
  }
  console.log(`
${"=".repeat(78)}`);
  console.log("TOTAL — search step only (extraction is billed separately)");
  console.log("=".repeat(78));
  line("billable searches", fleetSpend.calls);
  line("tokens in", `${fleetSpend.input} (+${fleetSpend.cachedInput} cached)`);
  line("tokens out", `${fleetSpend.output} (+${fleetSpend.reasoning} reasoning)`);
  line("token cost", `US$ ${(usd(fleetSpend) - costUsdOf(undefined, fleetSpend.calls)).toFixed(5)}`);
  line("search tool fees", `US$ ${(costUsdOf(undefined, fleetSpend.calls)).toFixed(5)}`);
  line("TOTAL", `US$ ${usd(fleetSpend).toFixed(5)}`);
  const perQuote = fleetSpend.calls > 0 ? usd(fleetSpend) / fleetSpend.calls : 0;
  line("per search", `US$ ${perQuote.toFixed(5)}`);
  line("per 1000 searches", `US$ ${(perQuote * 1000).toFixed(2)}`);
}

await main();
