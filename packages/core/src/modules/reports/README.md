# reports

Relatórios: conversation metrics, the funnel, the origin table, customer figures
and attribution. Owns `attribution_rule` and the three `service_*_attribution`
tables; reads the rest.

- **index.ts** — `createHttpPlugin({ unansweredQuotes })`, the only thing the app imports.
- **report-conversations/** — the slice: `GET /reports/conversations`. `queries.ts` does
  the reads; `index.ts` the route and `reportConversations(db, input, ports)`.
  See its `AGENTS.md`.
- **contracts/** — public: `reportFunnel` (the REP-15 rule conversations is tested
  against) and the HTTP schemas, defined in `contracts/http.reports.ts` since 5.1d.
- **internal/** — shared by the module's slices, importable by nobody else:
  - `aggregate.ts` — scoping, buckets, unanswered list, breakdowns → `buildReport`
  - `calendar.ts` — day/week/month buckets and the half-open period (the São Paulo
    day itself is `shared/sao-paulo-calendar.ts`)
  - `response-times.ts` — median, p90, first/subsequent stats, coverage
  - `attribution.ts` — REP-11 / REP-12 / quote-approval candidates and counts
  - `recompute-attribution.ts` — writes the missing attribution rows, inline on the read
  - `insights.ts`, `period-insights.ts`, `customer-figures.ts`, `service-revenue.ts` —
    KPIs, deltas, the funnel call, lapsed customers and average revenue
  - `*.fixture.ts` — test fixtures only

Moved from `apps/api/src/reports/` in adopt-modular-vertical-slices 2C.
