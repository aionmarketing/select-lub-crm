# quotes/internal/model-calls

How every research model call is made (background-oil-research D1–D3; switch-oil-research-to-openai). The call sites build their requests here instead of each on its own: the extractor, the passage selector, the link selector, escalation and the web search. Every call goes to the one configured OpenAI model, `gpt-6.1-sol` by default, on the Responses API. There is no other provider and no setting that selects one.

| File | What it is |
|---|---|
| `effort.ts` | The reasoning effort. `OIL_RESEARCH_REASONING_EFFORT` (default `medium`), the OpenAI table (`gpt-6.1-sol`: `low` to `max`), `configuredOpenAIEffort` and `openaiEffortFor`, which sends a model's default for a value it does not accept (reported once) and nothing to a model with no entry. |
| `research-model.ts` | The research model (`OIL_RESEARCH_MODEL`, default `gpt-6.1-sol`) and the `ESCALATION_MODEL` / `ESCALATION_EFFORT` overrides. Also `ModelTarget`, the Responses-API options a read sends (effort, `reasoningSummary: "auto"`, `store: false`), the output bound every call carries (`OIL_RESEARCH_MAX_OUTPUT_TOKENS`, default 25,000), the `provider:model:effort` key a run records at claim (`LEGACY_RESEARCH_MODEL_KEY` is what a row older than the column reads as), and `reportResearchModel`, the start-up report the worker calls. |
| `limits.ts` | D6's table of limits by (model, effort sent): idle time, call ceiling, web wall clock, run ceiling, and the unknown-call charge. `gpt-6.1-sol` at `medium` has a row (the 2026-10-12 benchmark); it keeps the placeholder's values, with no idle timer. Any other pair runs on the placeholder row, and `reportUnmeasuredOpenAILimits` logs it once at start-up. |
| `openai-retry.ts` | The one retry a research call gets. A rate-limit 429 or a 5xx is retried once, after `Retry-After` (capped at 10 s). A 429 for `insufficient_quota` is never retried. The first body is always read before the retry. The SDK's own retries are off for these calls. |
| `watchdog.ts` | The bounds a streamed call runs under (`idle` when a row has one, `ceiling`, `budget`) and the response tap that feeds the idle timer from the network. |
| `stream-call.ts` | `streamModelCall`: one streamed Responses call under those bounds, reported to the meter. |
| `meter.ts` | The per-run usage meter and its prices (`provider:model`, reasoning billed as output). `openai:gpt-6.1-sol` is priced at its list: 2.00 input, 0.10 cached, 2.50 cache write and 10.00 output, with long-context rates above 272K input. Tool calls are booked per item, and page actions are charged unless `WEB_SEARCH_BILL_PAGE_ACTIONS=false`. A model with no entry is charged conservatively and marked `pricedByFallback`. Runs recorded while GLM did the research keep their `glm:*` token keys and their recorded cost, and that cost still counts toward the day's spend. |
| `money.ts` | Strict parsing of money settings: a number ≥ 0 written with a dot, else the error is logged and the default applies. |
| `ports.ts` | `ModelPortOptions`: the transport, meter, outer signal and optional `target` a port factory accepts. `resolveCall` picks the target, or the configured research model from `OPENAI_API_KEY` / `OIL_RESEARCH_MODEL`. |
| `fake-openai.ts` | Test support only: a fake transport and streamed Responses API events, including reasoning summaries, `web_search_call` items, incomplete replies and error answers. |

OpenAI documents no keep-alive while a model reasons, so a call runs under its ceiling alone: the row has no idle timer. The 2026-10-12 benchmark saw events flow during reasoning (the longest gap between two stream events was 4.2 s), so the design is sound, and the PR B brief keeps the design without one.

The idle timer, when a row has one, is fed by the transport, not by the SDK's stream parts. `@ai-sdk/openai` holds every part back until the first content delta arrives, so a timer fed by parts would abort a call that is reasoning steadily.
