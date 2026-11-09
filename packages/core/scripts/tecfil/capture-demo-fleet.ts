/**
 * One-shot Tecfil capture for the demo fleet (oil-quote-liters-pricing task 1.2, design D9).
 *
 * This is a script, never part of `pnpm test` or `db:seed`. It writes into
 * `packages/core/fixtures/`, next to the ingested oil sources: everything `db:seed` reads
 * lives in one place, so "the seed opens no socket" is checkable by looking at one folder.
 *
 * Pacing is the whole point. `resolveFilters` is four GETs per car and the client fails
 * fast on 4xx, so a burst does not get a second chance — it just dies and the fixture
 * records `unavailable`. Therefore: one car at a time, a pause between cars, and a full
 * stop on 429 rather than a retry loop.
 *
 * Run with `pnpm --filter @select-lub/core tecfil:capture-demo-fleet`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFilters, TecfilError } from "../../src/kernel/clients/tecfil/index.js";
import type { TecfilIdentity } from "../../src/kernel/clients/tecfil/resolver.js";

/** Seconds between cars. Deliberately generous: this runs once, not per quote. */
const PAUSE_MS = 8_000;

/**
 * The identities the committed oil-source fixtures cover, so the seed can pair them up.
 *
 * `tecfilEngine` is Tecfil's OWN label for the same engine, copied verbatim from the
 * `options` list a previous unmatched run printed. The CRM spells an engine its way and
 * Tecfil spells it another; at runtime the LLM picker bridges that gap, but a capture must
 * not commit a model's choice to a fixture, so the bridge is recorded here by hand and is
 * checkable against Tecfil's list. It is set only where exactly one option matches: Tecfil
 * files the Polo's 128cv engine under `1.0 12V 128cv` (its `1.0 TSI 12V 128cv` entry exists
 * but carries no parts), and no other option is 128cv. The HR-V's `EX CVT` is a
 * trim, not an engine, and three Tecfil engines remain plausible — so it stays unmatched
 * rather than being guessed.
 */
const FLEET: Array<TecfilIdentity & { tecfilEngine?: string }> = [
  {
    make: "Volkswagen",
    year: "2021",
    model: "Polo",
    version: "1.0 TSI",
    tecfilEngine: "1.0 12V 128cv",
  },
  { make: "Honda", year: "2021", model: "HR-V", version: "EX CVT" },
];

/** One captured identity, `ok` with its fitment or a recorded failure. */
type CaptureRow = TecfilIdentity & {
  capturedAt: string;
  status: string;
  fitment?: unknown;
  field?: string;
  /** Tecfil's own spelling of the engine that was queried, when it differs from the CRM's. */
  tecfilEngine?: string;
  /** Tecfil's own labels for the field that did not match, recorded verbatim. */
  options?: string[];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Strips the Tecfil-side helper key, leaving the identity the CRM actually stores.
 *
 * @param entry - One fleet entry.
 * @returns The four CRM identity fields.
 */
function crmIdentityOf(entry: TecfilIdentity & { tecfilEngine?: string }): TecfilIdentity {
  return { make: entry.make, year: entry.year, model: entry.model, version: entry.version };
}

const rows: CaptureRow[] = [];

for (const [index, identity] of FLEET.entries()) {
  if (index > 0) {
    console.log(`pausa de ${PAUSE_MS / 1000}s antes do próximo veículo…`);
    await sleep(PAUSE_MS);
  }
  const label = `${identity.make} ${identity.model} ${identity.year} ${identity.version}`;
  console.log(`consultando Tecfil: ${label}`);

  try {
    // No LLM picker here on purpose: a capture records what Tecfil itself matched, so a
    // model-chosen name never becomes a committed fixture.
    const { tecfilEngine, ...crmIdentity } = identity;
    const result = await resolveFilters(
      tecfilEngine ? { ...crmIdentity, version: tecfilEngine } : crmIdentity,
    );
    const row: CaptureRow = {
      ...crmIdentity,
      capturedAt: new Date().toISOString(),
      status: result.status,
      ...(tecfilEngine ? { tecfilEngine } : {}),
    };
    if (result.status === "ok") {
      row.fitment = result.fitment;
      const oil = result.fitment.oilFilters.map((f) => f.partNumber).join(", ") || "—";
      const fuel = result.fitment.fuelFilters.map((f) => f.partNumber).join(", ") || "—";
      console.log(`  ok — óleo: ${oil} | combustível: ${fuel}`);
    } else {
      if ("field" in result && typeof result.field === "string") {
        row.field = result.field;
      }
      if ("options" in result && Array.isArray(result.options)) {
        row.options = result.options;
      }
      console.log(`  ${result.status}${row.field ? ` (${row.field})` : ""}`);
      if (row.options?.length) {
        console.log(`  opções da Tecfil para ${row.field}: ${row.options.join(" | ")}`);
      }
    }
    rows.push(row);
  } catch (err) {
    if (err instanceof TecfilError && err.status === 429) {
      // Too many requests: stop the whole run. Retrying into a rate limit is how a
      // capture turns into a ban.
      console.error("429 da Tecfil — interrompendo a captura. Tente novamente mais tarde.");
      rows.push({
        ...crmIdentityOf(identity),
        capturedAt: new Date().toISOString(),
        status: "rate_limited",
      });
      break;
    }
    console.error(`  falhou: ${String(err)}`);
    rows.push({
      ...crmIdentityOf(identity),
      capturedAt: new Date().toISOString(),
      status: "unavailable",
    });
  }
}

const out = join(dirname(fileURLToPath(import.meta.url)), "../../../db/fixtures");
mkdirSync(out, { recursive: true });
const file = join(out, "tecfil-demo-fleet.json");
writeFileSync(
  file,
  `${JSON.stringify({ capturedAt: new Date().toISOString(), identities: rows }, null, 2)}\n`,
  "utf8",
);
console.log(`\nescrito: ${file}`);
