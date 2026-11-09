# shared-types/src

A barrel since 5.1d — the shapes live in core.

- **index.ts** — `export * from "@select-lub/core/contracts"`, the web-safe entry that
  re-exports every module's `contracts/http.ts` and `shared/web/`.
- **barrel.test.ts** — the barrel still exports every name `apps/web`, `apps/api` and
  `apps/worker` import from this package.
- **package-deps.test.ts** — this package declares no dependency on the absorbed Motul
  package (moved from `remainder.test.ts`, because it reads this package's own manifest).

Where a shape lives now: `packages/core/src/modules/<module>/contracts/http.<topic>.ts`,
e.g. conversations' `http.conversation.ts`, customers' `http.vehicle.ts`, quotes'
`http.oil-quote.ts`; the test fixtures in each module's `http.fixtures.ts`; build
identity, the Omie field keys and the source classification in
`packages/core/src/shared/web/`.
