# worker/src

The worker's composition root. Two jobs in one process: accept Evolution webhooks,
then poll Postgres. Everything it runs is `@select-lub/core`'s — the kernel's
webhook app, job registry and settings; channel's transport (webhook receipt,
outbox drain and reclaim, connection reconcile, history paging); conversations'
ingest subscribers; prefill; scheduling; and the erp module's Omie pull.

- **index.ts** — process entry: loads `.env`, builds the ports, `listen`, `startWorker`,
  and stops both on SIGTERM / SIGINT
- **worker.ts** — `buildWorkerApp` (kernel's webhook app + channel's route + the
  canonicalize subscriber) and `startWorker` (the jobs below, the start-up one-shots,
  the heartbeat)

The one-shot history import is `pnpm --filter @select-lub/worker backfill:once`; its
script is `packages/core/scripts/backfill-once.ts` (moved there in wave 5.2).

## The loops

Every loop is a job on the kernel's registry (adopt-modular-vertical-slices 3A),
which runs one tick of each job at a time and skips a tick that fires while the
previous one is still running. Intervals, flags and their env names:
`kernel.resolveWorkerSettings`. Before 3A each loop kept its own in-flight flag, or
had none:

| loop                              | in-flight before | now                           |
| --------------------------------- | ---------------- | ----------------------------- |
| outbox drain (`channel`)          | yes              | registry                      |
| outbox reclaim (`channel`)        | yes              | registry                      |
| Omie incremental poll             | yes              | registry                      |
| heartbeat (retry, then reconcile) | no — reconcile   | registry; reconcile keeps its |
|                                   | alone had one    | own flag against the start-up |
|                                   |                  | reconcile (`singleFlight`)    |
| scheduled due tick + sync         | shared the drain | registry, as its own job,     |
|                                   |                  | `scheduling/due-and-sync`     |
| prefill (scan then drain)         | no               | registry, as its own job,     |
|                                   |                  | `prefill/enqueue-and-drain`   |
| manual download and parse         | —                | `quotes/ingest-manuals`       |
| manual reading, per identity      | —                | `quotes/read-manuals`         |
| oil research sweep (what to queue,| —                | `quotes/sweep-oil-research`   |
| heartbeat, manual upgrades)       |                  |                               |
| oil research runner (one identity | —                | `quotes/run-oil-research`     |
| per tick, then its Tecfil)        |                  |                               |

The two manual jobs run unless `MANUAL_INGESTION_ENABLED=false`. The two research jobs
(background-oil-research) run only with a database and `OIL_RESEARCH_ENABLED` exactly
`true`, which only `fly.toml` sets: off in development, in every test env (the Vitest
configs pin it off and blank the keys) and in the live e2e worker. Their ports are one
object, `quotes.createProductionResearchPorts(db)` here and fakes in tests. Without
`OPENAI_API_KEY` the runner claims nothing and logs `no_key`; the worker's other loops are
unaffected.

The scheduled due tick used to run in the SAME tick as the drain, before it, with
the outcome sync after it; they are separate jobs now (ruling Q1-A), so a row the
due tick queues is sent on the drain's next tick rather than this one, and the sync
reads outcomes up to one drain tick old. Both run every `WORKER_OUTBOX_POLL_MS`.
What made the split safe is the compare-and-set in channel's `enqueueOutbound`: the
due tick can no longer overwrite a row the drain claimed, sent or confirmed.

The heartbeat is one job, retry THEN reconcile (ruling Q2-A): both can write
`whatsapp_connection.connection_state`, and neither write is guarded by a timestamp.
The due tick and sync are one job (3B, ruling Q4) because both write
`scheduled_message`. Prefill's scan and drain are one job on their own poll (4C): the
window closes on silence, which no message event can signal.

On stop the timers stop at once, every tick's stop signal is aborted, and a tick
already in flight is waited for. A research run or a manual reading writes its release on
that signal at once and settles only once it has committed, so `fly.toml`'s
`kill_timeout = 30` is enough however long its model call would have run. A drain
finishing a send still publishes outbound-sent, so the subscribers come off, and the
shared client disconnects, only after every tick is done (`kernel.createStop`).
