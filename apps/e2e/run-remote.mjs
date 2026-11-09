/**
 * Runs Playwright with `playwright.remote.config.ts` against a published origin.
 *
 * Exists so the npm script is portable on Windows cmd, like `run-live.mjs`.
 * Expectations come from the environment: `E2E_BASE_URL` (required),
 * `E2E_EXPECT_COMMIT` (defaults to this checkout's HEAD), `E2E_EXPECT_VARIANT`
 * (defaults to `cursor`) and `E2E_WORKER_URL`.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

function headSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    cwd: here,
    shell: process.platform === "win32",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

const env = { ...process.env };
if (!env.E2E_EXPECT_COMMIT) {
  const head = headSha();
  if (head) env.E2E_EXPECT_COMMIT = head;
}

/**
 * Quotes an argument for cmd.exe: with `shell: true` Node only concatenates
 * args, so `--grep "two words"` would otherwise reach Playwright as two tokens.
 * Same helper as `run-tours.mjs`; `pnpm` is a .cmd shim, which is why the shell
 * is needed at all on Windows.
 *
 * @param {string} arg - One forwarded CLI argument.
 * @returns {string} The argument, wrapped in double quotes when it contains whitespace.
 */
function shellSafe(arg) {
  if (!/\s/.test(arg)) return arg;
  return `"${arg.replaceAll('"', '\\"')}"`;
}

const useShell = process.platform === "win32";
const forwarded = process.argv.slice(2).map((arg) => (useShell ? shellSafe(arg) : arg));

const child = spawn(
  "pnpm",
  ["exec", "playwright", "test", "--config", "playwright.remote.config.ts", ...forwarded],
  {
    stdio: "inherit",
    env,
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
