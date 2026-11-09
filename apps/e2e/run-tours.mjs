/**
 * Runs Playwright with a tour config (exploratory tour specs).
 *
 * Which config: `playwright.tours.config.ts` by default, or the one named by
 * `E2E_TOURS_CONFIG`. The disconnected-channel tour needs its own API process
 * pointed at a disconnected Evolution instance, so it has its own config and its
 * own ports; this runner is shared rather than copied, for the same reason the
 * configs share `tours-config.shared.ts` — a second copy is a second place for
 * the flag handling below to drift.
 *
 * Exists for the same reason as `run-live.mjs`: keeps the npm script portable on
 * Windows cmd and forwards extra args, so `pnpm test:e2e:tours --grep "Rumo
 * Errado"` selects one tour. Unlike the live runner it sets no opt-in flag —
 * tours cannot send, so there is nothing to opt into.
 *
 * NO `--` SEPARATOR. pnpm forwards a literal `--` into this script's argv, and
 * Playwright reads everything after it as positional file filters, so
 * `... -- --list` silently starts the whole stack instead of listing. Pass
 * flags directly: `pnpm test:e2e:tours --list --grep Obsessivo`.
 *
 * And `--grep` matches test TITLES, not filenames — every tour is titled
 * `Tour <name>: …`, so `--grep conversas-inbox` matches nothing. To run one
 * file, pass its path from inside `apps/e2e`.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Quotes an argument that would otherwise be split by the shell.
 *
 * `spawn` with `shell: true` CONCATENATES argv rather than escaping it (Node
 * warns DEP0190), so `--grep "Rumo Errado"` arrived at Playwright as two tokens
 * and the second was read as a file filter: "No tests found". Quoting here is
 * the documented workaround, and it is applied only to what the caller passed —
 * the fixed arguments above contain no spaces.
 *
 * @param arg - One forwarded command-line argument
 * @returns The argument, wrapped in double quotes when it contains whitespace
 */
function shellSafe(arg) {
  if (!/\s/.test(arg)) return arg;
  return `"${arg.replaceAll('"', '\\"')}"`;
}

const useShell = process.platform === "win32";
const forwarded = process.argv.slice(2).map((arg) => (useShell ? shellSafe(arg) : arg));

const config = process.env.E2E_TOURS_CONFIG ?? "playwright.tours.config.ts";

// Sign-in goes to the LOCAL Supabase, never the hosted project (OpenSpec
// tours-local-supabase). `prepare` checks that local Auth answers on
// 127.0.0.1:54321, makes sure the committed test user exists, and prints the
// tour auth env as one JSON line. It is assigned onto THIS process's env before
// anything else runs, so the database seed links the test user (SEED_USER_A_ID)
// and Playwright, its config and every server it spawns inherit the local
// values; the config re-asserts them after its `.env` load. When local Supabase
// is down this exits here, naming `pnpm tours:supabase:start`, before any
// database is touched — it never falls back to the `.env`'s login.
const prepared = spawnSync("pnpm", ["exec", "tsx", "local-supabase.ts", "prepare"], {
  stdio: ["ignore", "pipe", "inherit"],
  cwd: here,
  shell: useShell,
  encoding: "utf8",
});
if (prepared.status !== 0) {
  process.exit(prepared.status ?? 1);
}
const authLine = prepared.stdout.trim().split(/\r?\n/).at(-1) ?? "";
Object.assign(process.env, JSON.parse(authLine));

// Provision the dedicated tour database (`--tours`, apart from the e2e one —
// see `deriveToursDatabaseName`) BEFORE Playwright starts, as the default
// `test` script does. It cannot be left to `globalSetup`: Playwright starts the
// `webServer` processes first, so the tour's API booted against a database that
// did not exist yet, and every tour timed out waiting for /health with nothing
// in the log naming the database. The fixed arguments contain no spaces, so the
// shell needed for the pnpm shim on Windows splits nothing.
const provisioned = spawnSync("pnpm", ["exec", "tsx", "provision-e2e-database.ts", "--tours"], {
  stdio: "inherit",
  cwd: here,
  shell: useShell,
});
if (provisioned.status !== 0) {
  process.exit(provisioned.status ?? 1);
}

const child = spawn(
  "pnpm",
  ["exec", "playwright", "test", "--config", config, ...forwarded],
  {
    stdio: "inherit",
    cwd: here,
    shell: useShell,
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
