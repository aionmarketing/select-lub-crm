/**
 * `@select-lub/core/contracts` — the web-safe entry: every module's HTTP contract
 * and the shared kernel's web vocabulary, and nothing else.
 *
 * `@select-lub/shared-types` is a barrel over this file, which is how `apps/web`
 * gets its request and response shapes (5.1d). Everything this file reaches must
 * import only `zod`, other modules' `contracts/http.ts` and `shared/web/` — never
 * Prisma, Fastify, `pg` or `node:*`, which would land in the browser bundle.
 *
 * Two guards hold that. Per-file lint rules (`no-restricted-imports` and
 * `no-restricted-syntax` on each `modules/<module>/contracts/http*.ts` and
 * `shared/web/<file>.ts`) check each contract file's own imports, static and
 * dynamic. THIS file is
 * excluded from the lint, like `src/index.ts` (the package's entry, not one of the
 * scopes), so what guards it is `packages/core/test/web-contracts.test.ts`: it
 * walks the graph from here, static and dynamic imports alike, and also checks
 * each name is declared once and that there is no runtime import cycle.
 */
export * from "./modules/accounts/contracts/http.js";
export * from "./modules/channel/contracts/http.js";
export * from "./modules/conversations/contracts/http.js";
export * from "./modules/customers/contracts/http.js";
export * from "./modules/plate-lookup/contracts/http.js";
export * from "./modules/prefill/contracts/http.js";
export * from "./modules/quotes/contracts/http.js";
export * from "./modules/reports/contracts/http.js";
export * from "./modules/scheduling/contracts/http.js";
export * from "./modules/services/contracts/http.js";
export * from "./shared/web/build-identity.js";
export * from "./shared/web/omie-field-keys.js";
export * from "./shared/web/source-classification.js";
