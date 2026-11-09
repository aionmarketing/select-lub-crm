# report-conversations

**Purpose.** `GET /reports/conversations`: the Relatórios report for the
caller's unit and one period — conversation volume and buckets, response times,
coverage and the unanswered list, the REP-15 funnel, the origin table, the
customer figures (lapsed customers, average revenue), scheduled-message counts,
and the REP-11 / REP-12 / quote-approval attribution counts. Each primary figure
carries a delta against the preceding equal-length period.

**Kind.** HTTP route. The logic is the plain function
`reportConversations(db, { unitId, query }, ports)`; the route is
`reportConversationsRoute(ports)`, mounted by the module's `createHttpPlugin`.

**Tables written** (all owned by `reports`, under `db.tx("reports", …)`):

- `service_scheduled_attribution`
- `service_conversation_attribution`
- `service_quote_attribution`

Written by `../internal/recompute-attribution.ts`, not by this folder. Reading
the report inserts the attribution rows its cut is missing, after the reads, so
the counts it returns include them. That trigger —
the read itself — is why the recompute is internal logic and not a slice of its
own (W2-C4).

**Tables read** (foreign reads, `readableBy: "*"`): `conversation`, `message`,
`conversation_tag`, `tag`, `whatsapp_connection`, `scheduled_message`,
`service`, `oil_quote`, `interval_rule`, and this module's own
`attribution_rule` and the three attribution tables.

**Ports.** `unansweredQuotes(quotes, inbounds, unitId)` — the follow-up rules'
count of sent quotes still awaiting a reply. Follow-up is not a module yet, so
`apps/api` supplies it from `follow-up/aggregate.ts`'s existing function.

**Invariants.**

- The unit is the one the auth hook resolved (`kernel.unitIdOf`). A request that
  reaches the slice with none is answered 403 before anything is read.
- A conversation belongs to a unit only through its `whatsapp_connection`; there
  is no unit column on `conversation`. Every conversation read goes through that
  join.
- Every statement runs in its own short `db.tx("reports", …)`: the ten reads
  together in one `Promise.all`, then the three inserts one at a time. That is
  the old adapter's autocommit shape. Statements are grouped in one `db.tx` only
  when they must commit or fail together, and none here must — so no statement
  shares Prisma's 5 s interactive-transaction budget with another, and nothing
  inside a `db.tx` awaits anything but the database.
- Attribution inserts are idempotent: `skipDuplicates` on each table's unique
  key, so a repeat read, or two concurrent ones, adds no row twice.
- The funnel is `../contracts/funnel.ts`'s `reportFunnel`, the published rule the
  conversations module is tested against; this slice never computes stages any
  other way.
- A tag, campaign or origin filter narrows the conversations and the scheduled
  rows reached through them, and drops scheduled rows reached only through a
  service.

**Tests.** `tests/` — the HTTP cases through `buildSliceApp`, the attribution
cases, the row mapping through the plain function, and one live file over
committed rows that asserts it leaves no unit behind. The auth hook's 403 on a
unit the caller is not in, with a 200 control and the real binding of the
unanswered-quote port, is in `apps/api/test/reports.integration.test.ts`,
because the hook and that binding live in `apps/api`. The hook's 401 without a
token is its own suite's, `apps/api/src/auth.test.ts`.
