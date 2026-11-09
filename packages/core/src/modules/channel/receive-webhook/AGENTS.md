# receive-webhook

**Purpose.** Accept Evolution's webhooks: authenticate, store the raw body, answer 200 fast
so Evolution does not retry, then hand the stored event over.

**Kind.** HTTP route on the WORKER's app, `POST /webhooks/evolution`. Entry points:
`route({ secret, log })`, mounted by the module's `createWebhookPlugin(deps)`;
`summarizeWebhook(body)`; the write itself is the contract `recordWebhookEvent`. The worker's composition root
builds the app (50 MiB body limit, `GET /health`), binds the database handle, and
registers this.

**Tables written** (`channel`-owned, one `db.tx("channel", …)`): `webhook_event`, status
`received`. Reads `whatsapp_connection` to link the row to its connection.

**Events published.** `channel/webhook-received` with the row id, AFTER the 200 is sent,
awaited. Until 4A its subscriber is ingestion's `canonicalizeEvent`, wired by
`apps/worker`, which also drives the rest of the `webhook_event` lifecycle.

**Invariants.**

- 503 `webhook_secret_unset` without a secret, 503 `database_unset` without a bound
  handle, 401 unless `Authorization` is exactly `Bearer <secret>` — each before any write.
- The log line carries event, instance and provider id only: never the body or the secret.
- An envelope naming an unknown instance is still stored, with no connection.
- The receipt's one transaction runs with `WEBHOOK_RECEIPT_TRANSACTION_OPTIONS` (60 s run
  limit, not the kernel's 5 s): a `messages.set` dump can be up to 50 MiB, and a timeout
  would answer 500 and be redelivered.
- Its subscriber is recorded as exception W3-C6 until 4A.

**Tests.** `tests/receive-webhook.options.test.ts` (2: the receipt's transaction options) and
`tests/receive-webhook.integration.test.ts`, 9 cases moved from
`apps/worker/src/webhook.test.ts`: the 5 receipt cases and the 4 `summarizeWebhook`
cases. The other 9 of that file's 18 pin the worker's app or canonicalization and live in
`apps/worker/test/app.test.ts`.

**Blocked on core.** Nothing. The envelope readers live in `contracts/evolution-format.ts`,
shared with conversations since 4A.
