/**
 * `@select-lub/shared-types` — a barrel over `@select-lub/core/contracts`.
 *
 * Since 5.1d the request and response shapes are defined in each core module's
 * `contracts/http.ts` (and the shared kernel's `shared/web/`); this package only
 * re-exports them, so `apps/web`, `apps/api` and `apps/worker` keep importing
 * `@select-lub/shared-types` unchanged. The dependency points from here to core,
 * never back: core does not import this package.
 */
export * from "@select-lub/core/contracts";
