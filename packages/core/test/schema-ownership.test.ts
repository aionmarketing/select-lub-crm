/**
 * Test design — the schema and ownership.json cannot drift
 *
 * SUT: `packages/core/prisma/schema/<module>.prisma` against `ownership.json`.
 * Two directions, because the requirement names both: a model in a module's
 *   schema file whose table the manifest assigns elsewhere, and a table the
 *   manifest owns with no model behind it. Either is a drift the role grants
 *   would silently paper over — the first writes under the wrong role, the
 *   second grants on a table that does not exist.
 * Why parse the .prisma text rather than ask Prisma: the mapping from file to
 *   module is the thing under test, and Prisma flattens the folder into one
 *   schema before anyone can see which file a model came from.
 * `pendingTables` lets a table be owned ahead of the migration that creates it.
 *   `erp_outbox` was the one such table, from wave 1 until wave 3A's migration
 *   created it; the manifest now declares none, and the last case below keeps it
 *   that way until someone adds one on purpose.
 * Out of scope: column-level agreement. Nothing claims the manifest knows about
 *   columns.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCHEMA_DIR = resolve(ROOT, "packages/core/prisma/schema");

interface Ownership {
  modules: Record<string, { tables: string[] }>;
  pendingTables?: Record<string, string>;
}

const own = JSON.parse(readFileSync(resolve(ROOT, "ownership.json"), "utf8")) as Ownership;
const pending = new Set(Object.keys(own.pendingTables ?? {}));

/** Every `@@map` in one module's schema file, with the model it belongs to. */
function modelsIn(file: string): { model: string; table: string }[] {
  const text = readFileSync(resolve(SCHEMA_DIR, file), "utf8");
  const out: { model: string; table: string }[] = [];
  const blocks = text.split(/^model\s+/m).slice(1);
  for (const block of blocks) {
    const model = /^(\w+)/.exec(block)?.[1];
    const table = /@@map\("([^"]+)"\)/.exec(block)?.[1];
    if (model && table) out.push({ model, table });
  }
  return out;
}

const moduleFiles = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".prisma") && f !== "schema.prisma");

describe("schema files and ownership.json agree", () => {
  it("has one schema file per module in the manifest", () => {
    expect(moduleFiles.map((f) => f.replace(/\.prisma$/, "")).sort()).toEqual(
      Object.keys(own.modules).sort(),
    );
  });

  for (const file of moduleFiles) {
    const module = file.replace(/\.prisma$/, "");
    it(`every model in ${file} maps to a table owned by ${module}`, () => {
      const owned = new Set(own.modules[module]!.tables);
      for (const { model, table } of modelsIn(file)) {
        expect(owned, `model ${model} maps to ${table}, which ${module} does not own`).toContain(table);
      }
    });
  }

  it("every owned table has a model, except the ones declared pending", () => {
    const modelled = new Set(moduleFiles.flatMap((f) => modelsIn(f).map((m) => m.table)));
    const missing: string[] = [];
    for (const [module, entry] of Object.entries(own.modules)) {
      for (const table of entry.tables) {
        if (!modelled.has(table) && !pending.has(table)) missing.push(`${module}.${table}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("declares no table pending now that erp_outbox exists", () => {
    // 3A's migration created the one pending table. A stale entry would keep
    // exempting a table after its model appeared, so an exemption has to be
    // added on purpose, with this expectation changed alongside it.
    expect([...pending]).toEqual([]);
  });

  it("assigns every table exactly once", () => {
    const seen = new Map<string, string>();
    for (const [module, entry] of Object.entries(own.modules)) {
      for (const table of entry.tables) {
        expect(seen.has(table), `${table} owned by both ${seen.get(table)} and ${module}`).toBe(false);
        seen.set(table, module);
      }
    }
  });
});
