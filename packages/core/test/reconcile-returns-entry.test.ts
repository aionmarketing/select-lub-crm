/**
 * Test design (testing-strategy)
 *
 * SUT: `pnpm db:reconcile-returns`, the real script, spawned — its refusal when
 *   `DATABASE_URL` is not set in the shell, even with a `.env` that names a
 *   database.
 *
 * Oracle: review of #167 (owner rulings PR 3) — the script must be pointed at a
 *   database explicitly. `@select-lub/core/db`'s client loads the repo `.env`
 *   when `DATABASE_URL` is unset, and ESM evaluates static imports before a
 *   module's body, so a static import of anything Prisma in the entry let the
 *   `.env` (production, in the main checkout) supply the URL its own guard then
 *   allowed.
 *
 * HOW THE `.env` IS PRESENT WITHOUT WRITING ONE. A real `.env` written at the
 *   repo root during a parallel run would change what every other file loads
 *   (web tests break with one). So the child gets a preload through
 *   NODE_OPTIONS: `existsSync` answers true for any `.env` path, and
 *   `process.loadEnvFile` sets `DATABASE_URL` to a sentinel on port 1 — exactly
 *   what loading a `.env` that names a database would do, and unreachable, so
 *   nothing could be written even by a regression. Whatever calls
 *   `loadEnvFile` before the guard makes the guard see the sentinel and print
 *   `writing to 127.0.0.1`, which fails the case (the feared action leaves a
 *   mark). Mutation-checked: restoring the static import of `kernel/db.js` in
 *   the script fails it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const PNPM_NEEDS_SHELL = process.platform === "win32";
const dir = mkdtempSync(join(tmpdir(), "reconcile-entry-"));
const preload = join(dir, "dotenv-present.mjs");
writeFileSync(
  preload,
  `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const realExists = fs.existsSync;
fs.existsSync = (path) => (String(path).endsWith(".env") ? true : realExists(path));
syncBuiltinESMExports();
process.loadEnvFile = () => {
  process.env.DATABASE_URL = "postgresql://sentinel:x@127.0.0.1:1/named_by_dotenv";
};
`,
);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("pnpm db:reconcile-returns — entry guard", () => {
  it(
    "refuses with DATABASE_URL unset in the shell, even when a .env names a database",
    () => {
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
      delete env.DATABASE_URL;
      delete env.DATABASE_URL_TEST;

      const run = spawnSync("pnpm", ["db:reconcile-returns"], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
        shell: PNPM_NEEDS_SHELL,
      });
      const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;

      expect(run.status).not.toBe(0);
      expect(output).toContain("reconcile-returns: refusing to run — DATABASE_URL is not set");
      expect(output).not.toContain("writing to");
    },
    120_000,
  );
});
