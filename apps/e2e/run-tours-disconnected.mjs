/**
 * Runs the disconnected-channel tour via `playwright.tours-disconnected.config.ts`.
 *
 * A three-line wrapper rather than a copy of `run-tours.mjs`: that file carries
 * the Windows quoting workaround and the no-`--` rule, and a second copy would
 * be a second place for both to drift. Setting the variable here rather than in
 * the npm script keeps it portable on Windows cmd, which has no `VAR=x cmd`
 * form — the same reason `run-tours.mjs` exists at all.
 */
process.env.E2E_TOURS_CONFIG = "playwright.tours-disconnected.config.ts";
await import("./run-tours.mjs");
