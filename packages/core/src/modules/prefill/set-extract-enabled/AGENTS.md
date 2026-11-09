# prefill / set-extract-enabled

**Purpose.** `PATCH /conversations/:id/prefill/extract-enabled`: the rail's
Sugerir dados do cliente switch.

**Kind.** HTTP command. Entry point: `route`.

**Tables written.** None of prefill's. `conversation.prefill_extract_enabled` and
`last_prefill_window_closed_at` through `conversations`' `setExtractEnabled`.

**Invariants.**

- Turning the switch ON stamps the watermark to now, so silence that passed
  while it was off is never extracted.
- 404 for an unknown or another loja's conversation.

**Tests.** `tests/set-extract-enabled.integration.test.ts`, 1 case moved from
`apps/api/src/cadastro.prefill.test.ts`. Its two switch cases read back through
`GET …/prefill` and are in `apps/api/test/prefill.integration.test.ts`.

**Blocked on core.** Nothing.
