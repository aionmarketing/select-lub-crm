/**
 * Quotes' HTTP contract: the request and response shapes its routes validate, and
 * the ones `apps/web` imports through `@select-lub/shared-types` (a barrel over
 * `@select-lub/core/contracts`).
 *
 * Defined here since 5.1d; before, they lived in `shared-types` and were re-exported here
 * (W2-C2). WEB-SAFE: every file this reaches imports only `zod`, other modules'
 * `contracts/http.ts` and `shared/web/` — per-file lint rules and
 * `packages/core/test/web-contracts.test.ts` hold that. Each name is exported by exactly
 * one module's http contract.
 */
export * from "./http.catalog.js";
export * from "./http.fixtures.js";
export * from "./http.motul-compatibility.js";
export * from "./http.oil-attendant-fill.js";
export * from "./http.oil-quote.js";
export * from "./http.oil-research.js";
export * from "./http.oil-source-candidate.js";
export * from "./http.tecfil-compatibility.js";
