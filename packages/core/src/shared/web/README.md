# shared/web

The shared kernel's web vocabulary (5.1d): names the browser bundle needs that belong
to no one module, or that the kernel needs and so cannot take from a module.
`@select-lub/core/contracts` re-exports these files, so each may import only `zod`
and its siblings — never `../index.ts`, whose `ids.ts` imports `node:crypto`.

- **build-identity.ts** — the build's git commit and UI variant, and the health bodies
  that report them (`apps/api`, `apps/worker`, `apps/web`).
- **omie-field-keys.ts** — the shared fields the CRM and Omie keep in sync (the
  kernel's ERP port and customers' contract).
- **source-classification.ts** — what kind of document an oil-spec source is (the
  kernel's persistence layer tiers it; quotes' contract carries it).
