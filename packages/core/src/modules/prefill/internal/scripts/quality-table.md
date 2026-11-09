# Prefill quality table

Scored against labeled Evolution POC transcripts in gitignored `fixtures/poc/`. Counts only — no WhatsApp bodies.

| field | match | wrong | invented | miss |
| --- | --- | --- | --- | --- |
| name | not-run | not-run | not-run | not-run |
| taxId | not-run | not-run | not-run | not-run |
| plate | not-run | not-run | not-run | not-run |
| make | not-run | not-run | not-run | not-run |
| model | not-run | not-run | not-run | not-run |
| version | not-run | not-run | not-run | not-run |
| year | not-run | not-run | not-run | not-run |
| odometerKm | not-run | not-run | not-run | not-run |
| shouldReply | not-run | not-run | not-run | not-run |

- Model: not-run
- Fixtures scored: 0
- Run date: 2026-08-31

MVP go/no-go: auto-trigger is the 60s silence window (`should-reply-window`); a fully-filled cadastro still extracts. Extra cost gates remain GitHub #28 — re-measure after this change, because every closed window calls the LLM.
