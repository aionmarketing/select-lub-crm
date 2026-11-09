/**
 * Test design — the generated grants cannot go stale
 *
 * SUT: `scripts/gen-grants.ts` against the committed `db/grants.generated.sql`
 *   and `packages/core/src/kernel/db.modules.generated.ts`.
 * The requirement ("The manifest and the generated grants cannot drift") is a
 *   claim about two files agreeing with a third, so it is checked as one: run
 *   the generator in `--check` mode, which regenerates both in memory and
 *   diffs. A non-zero exit names the stale file, which is what the scenario
 *   asks for.
 * Why a subprocess and not an import: the generator is repository tooling at
 *   the root, outside this package's `rootDir`, and importing across that
 *   boundary would put a build-time script into the shipped module graph. It is
 *   also literally the check CI would run.
 * A decoy proves the check can fail: `ownership.json` is parsed, a table is
 *   added to a module in memory, and the rendered SQL is asserted to differ —
 *   so a passing `--check` is a finding rather than a generator that returns
 *   the same bytes whatever it is given.
 * Out of scope: whether the SQL is correct Postgres. `roles.test.ts` runs it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderGrantsSql, renderModulesTs, type Ownership } from "../../../scripts/gen-grants.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function ownership(): Ownership {
  return JSON.parse(readFileSync(resolve(ROOT, "ownership.json"), "utf8")) as Ownership;
}

describe("generated grants", () => {
  it("are current with ownership.json", () => {
    // Throws with the generator's stderr — which names the stale file — on exit 1.
    const out = execFileSync("pnpm", ["exec", "tsx", "scripts/gen-grants.ts", "--check"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // `pnpm` is a .cmd shim on Windows, which Node will only launch through a
      // shell. Safe here: none of the arguments contains a space.
      shell: process.platform === "win32",
    });
    expect(out).toContain("up to date");
  });

  it("render every module as a role", () => {
    const own = ownership();
    const sql = renderGrantsSql(own);
    for (const module of Object.keys(own.modules)) {
      expect(sql).toContain(`module_${module.replace(/-/g, "_")}`);
    }
  });

  describe("the check itself", () => {
    it("renders different SQL when a table moves, so agreement above is a finding", () => {
      const own = ownership();
      const before = renderGrantsSql(own);
      const mutated: Ownership = {
        ...own,
        modules: {
          ...own.modules,
          reports: { ...own.modules.reports!, tables: [...own.modules.reports!.tables, "customer"] },
        },
      };
      expect(renderGrantsSql(mutated)).not.toEqual(before);
      expect(renderModulesTs(mutated)).not.toEqual(renderModulesTs(own));
    });
  });
});
