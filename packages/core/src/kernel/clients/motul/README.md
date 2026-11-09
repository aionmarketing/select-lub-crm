# motul

Motul Oil Advisor HTTP client. No LLM SDK. Used by the quotes module
(`packages/core/src/modules/quotes/internal/`, including its `motul-agent/`) and
by the demo script. Moved here from `packages/motul` in wave 5.1a; reached as
`clients.motul.*` or, inside core, `kernel/clients/motul/index.js`.

- **client.ts** — HTTP getters (`getVehicleBrands`, oil recommendation, `MotulError`), retry and circuit breaker
- **wire.ts** — types matching Motul's JSON
- **flatten.ts** — nested recommendation → flat products/capacities
- **pick-fill.ts** — motor liters for the oil quote (service fill over dry fill)
- **resolver.ts** — match CRM make/model/year/version to Motul ids
- **index.ts** — public barrel
- **fixtures/**, **golden/** — recorded recommendations and the flattened outputs the tests compare against
- **captures/** — committed live captures the capture scripts write
- Tests beside the code; `flatten.test.ts` is split with `flatten.upsell.test.ts` and
  `flatten.arms.test.ts` over `flatten.fixture.ts`, and `client.test.ts` with
  `client.breaker.test.ts` (core's 300-line cap). None reaches Motul.

Scripts (network; not CI), in `packages/core/scripts/motul/`:

- `pnpm --filter @select-lub/core motul:demo` — sample vehicle chain
- `pnpm --filter @select-lub/core motul:capture-demo-fleet` — paced Polo 2014 / HR-V 2021 live capture
- `pnpm --filter @select-lub/core motul:capture-brazil-motor-catalogue` — paced Brazil motor product list + product pages

**Circuit breaker.** After `MOTUL_BREAKER_FAILURES` (default 3) consecutive exhausted-retry failures, calls fail fast with the exhausted-path `MotulError` — no request — for `MOTUL_BREAKER_COOLDOWN_MS` (default 600 000). The first call after the cool-down is a probe: success closes the breaker, failure re-opens it. A 4xx does not count. The resolver maps an open breaker to `unavailable`, as it does any exhausted failure.

**Hours-long outages.** The breaker above is per process and lasts minutes. Background research keeps the longer memory (`oil_research_runner.motul_failing_since`): after `MOTUL_DEGRADED_AFTER_MS` (default 6 h) of failure without an answer, the research adapter answers `none` for `unavailable`, so a run stays complete and stops feeding the research outage breaker. Every run still calls the resolver, and any answer clears the state (oil-research-web-retrieval D6).
