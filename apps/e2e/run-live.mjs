/**
 * Runs Playwright with `playwright.live.config.ts` and `E2E_LIVE_SCHEDULE=1`.
 * Exists so the npm script is portable on Windows cmd (inline `VAR=1` is POSIX-only).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

const child = spawn(
  "pnpm",
  ["exec", "playwright", "test", "--config", "playwright.live.config.ts", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: { ...process.env, E2E_LIVE_SCHEDULE: "1" },
    cwd: here,
    shell: process.platform === "win32",
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
