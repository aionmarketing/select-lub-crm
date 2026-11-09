/**
 * Test design (testing-strategy) — the barrel still exports what the apps import
 *
 * SUT: `@select-lub/shared-types`, a barrel over `@select-lub/core/contracts` since
 *   5.1d.
 * Oracle: 5.1d ruling — `apps/web`, `apps/api` and `apps/worker` keep importing
 *   this package unchanged, so every name they import from it must still be
 *   exported. `export *` silently drops a name two sources both export, which no
 *   compile error flags at the barrel; this is the check at the consumers.
 * How: every `import … from "@select-lub/shared-types"` under apps/ is read. A
 *   name core declares as a VALUE must be a key of the runtime barrel; a name
 *   core declares as a TYPE must be declared in one of the web contract files
 *   (types do not exist at runtime); any other name fails.
 * Reach control: the apps import well over 100 names, so a scan that finds none
 *   (a moved folder, a changed quote style) cannot pass.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as barrel from "./index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function filesUnder(dir: string, test: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "ts-dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path, test));
    else if (test(entry.name)) out.push(path);
  }
  return out;
}

function importedNames(): Set<string> {
  const names = new Set<string>();
  for (const app of ["web", "api", "worker"]) {
    for (const file of filesUnder(join(ROOT, "apps", app), (n) => /\.(ts|tsx)$/.test(n))) {
      const code = readFileSync(file, "utf8");
      for (const m of code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"@select-lub\/shared-types"/g)) {
        for (const item of m[1]!.split(",")) {
          const name = item.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
          if (name) names.add(name);
        }
      }
    }
  }
  return names;
}

function declaredTypes(): Set<string> {
  const types = new Set<string>();
  const core = join(ROOT, "packages/core/src");
  const contractFiles = [
    ...filesUnder(join(core, "modules"), (n) => /^http(\.[a-z-]+)?\.ts$/.test(n)),
    ...filesUnder(join(core, "shared/web"), (n) => /\.ts$/.test(n) && !n.endsWith(".test.ts")),
  ].filter((f) => f.split(/[\\/]/).includes("contracts") || f.includes("shared"));
  for (const file of contractFiles) {
    for (const m of readFileSync(file, "utf8").matchAll(/^export (?:type|interface) ([A-Za-z_$][\w$]*)/gm)) types.add(m[1]!);
  }
  return types;
}

describe("@select-lub/shared-types (barrel over @select-lub/core/contracts)", () => {
  const names = importedNames();
  const types = declaredTypes();
  const values = new Set(Object.keys(barrel));

  it("finds the names the apps import", () => {
    expect(names.size).toBeGreaterThan(100);
  });

  it("exports every name the apps import", () => {
    const missing = [...names].filter((n) => !values.has(n) && !types.has(n)).sort();
    expect(missing).toEqual([]);
  });
});
