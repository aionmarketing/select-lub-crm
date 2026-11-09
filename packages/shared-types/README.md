# shared-types (`@select-lub/shared-types`)

A barrel over `@select-lub/core/contracts` since 5.1d. The Zod schemas and TypeScript
types the web, API and worker share are defined in each core module's
`contracts/http.<topic>.ts` (and the shared kernel's `shared/web/`); this package
re-exports them, so its consumers import `@select-lub/shared-types` unchanged.

- **src/index.ts** — `export * from "@select-lub/core/contracts"`.
- **src/barrel.test.ts** — every name the apps import is still exported.

The dependency runs from here to core only: core does not import this package.
