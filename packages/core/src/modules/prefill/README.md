# prefill

Assistive cadastro extraction: the job queue and the suggestions an attendant accepts or
rejects. Owns `cadastro_prefill_job` and `cadastro_prefill_suggestion`. Everything it writes
on another module's tables goes through that module's contracts — the customer and its
fields through `customers`', the thread link, the switch, the `should_reply` labels and the
watermark through `conversations`'. The LLM call and the Omie push are provider calls and
never run inside a `db.tx`.

- **index.ts** — the only thing a composition root imports:
  - `createHttpPlugin({ omieAdapter })` — the six routes; the adapter lives in the
    plugin's closure, one per app.
  - `createJobs(deps)` — ONE job, `prefill/enqueue-and-drain`, every
    `WORKER_PREFILL_POLL_MS`: the silence-window scan, then one drain. A poll, not a
    `message-received` subscription (4C ruling). `createPrefillJob(db)` is its port;
    the worker's composition test wraps it.
- **get-prefill/**, **accept-prefill-field/**, **accept-all-prefill/**,
  **reject-prefill-field/**, **retry-prefill/**, **set-extract-enabled/** — the routes,
  paths unchanged from `apps/api/src/prefill`.
- **enqueue-prefill/**, **drain-prefill/** — the job's two steps. Each slice has an
  `AGENTS.md`.
- **contracts/http.ts** — the web contract, over `http.prefill.ts` (defined here since 5.1d).
- **internal/** — shared by the slices:
  - `reads.ts` — the job, window-scan, recent-text and cadastro-snapshot reads
  - `suggestion.ts` — the suggestion's view, fields and per-field strip
  - `view.ts` — map rows to the rail's `extracting` / `pending` / `failed` / `empty`
  - `accept.ts`, `accept-field.ts` — resolve or create the customer; accept one field
    through `customers`' `applyPrefillSuggestion`, then strip it
  - `extract.ts`, `gate.ts`, `window.ts` — the LLM call (OpenAI by default, a fake in
    every test), the v1 field gate, the 60-second silence window
  - `cadastro-snapshot.ts` — the snapshot types and the `PLACA`-sourced keys the LLM
    must not reopen
  - `params.ts`, `ports.ts` — path params and empty bodies; `PrefillPorts`
  - `scripts/score.ts` — `pnpm --filter @select-lub/worker prefill:score`, the offline
    quality table; skips without `OPENAI_API_KEY`
