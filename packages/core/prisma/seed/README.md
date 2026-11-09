# seed

Demo and base rows written by `pnpm db:seed`.

- **env.ts** — `SEED_DEMO=0` / `false` skips demo (deploy); default is on. `OMIE_MOCK_DATASET=tidsci` is the second opt-in; skip also skips TIDSCI even if `.local/` JSON exists
- **faker.ts** — `@faker-js/faker` locale `pt_BR`, seed `20260831`
- **plan.ts** — deterministic customer names/phones/plates and the workshop completeness mix (thin / partial / active / one rich; pré-cadastro chats)
- **history.ts** — writes `SEED` threads on existing 1:1 conversations (ids, skip, timestamps). Default planner is generic 5–20; demo passes the workshop mix.
- **thread-archetypes.ts** — one workshop script per conversation; unfilled reported, never doubled
- **thread-templates.ts** — pt-BR scripts, distractors ≠ ficha, typo transform that skips identifier slots
- **workshop-threads.ts** — assignment + templates for the demo seed
- **thread-mix-summary.ts** — gitignored `artifacts/demo-seed/thread-mix.md` (no phones or bodies)
- **connections.ts** — four demo instance names, never equal to `EVOLUTION_INSTANCE_NAME`
- **demo.ts** — upserts the demo dataset (conversations hang off the live instance). Writes `SEED` messages; never creates conversations, webhook events, or outbox. Never creates `TIDSCI EMP0N` units; archive clients land on `Select Lub` via worker pull. Includes one mock `PlateLookup` / `PlateLookupCall` pair so those tables have rows without spending provider credit.
- **mock-omie.ts** — mock Omie identifiers shared with core's `kernel/clients/erp-mock` (`mockOmieDataset`). Default seed never reads `tid_archive` or `.local/` JSON

Determinism is per lockfile + `DEMO_FAKER_SEED`. Re-runs upsert; they do not wipe.

## What is real and what is fake

**Phone numbers are real. Seeded thread bodies are fake. Live WhatsApp bodies stay until scrubbed.**

The demo dataset is layered *over* real conversations (chat keys / phones). The
seed writes `Message` rows with origin `SEED` — a workshop mix of pt-BR threads
(1–4 messages on a bare-hours chat, 5–20 otherwise) per existing 1:1 conversation
— and sets that conversation's activity timestamps from those rows. Live ingest
(`LIVE`) is untouched by the seed. Re-running does not rewrite a conversation
that already has `SEED` rows; delete those rows first to apply a new mix.

- `pnpm db:scrub-live` deletes `LIVE` messages, outbox
  on those conversations, and webhook events for the live instance. Conversations
  and `SEED` threads stay. Same host refusals as seed, except the pristine base
  is allowed so its real bodies can be stripped after import.
- A screenshot of Conversas still contains real phone numbers. After scrub+seed
  the bubbles are fake; until then leftover `LIVE` rows remain visible.
- `shouldReply` labels are applied to **seeded** inbound messages, not to live
  history.

## The seed creates no conversations

It decorates the ones already there. `conversation`, `webhook_event` and
`outbox_message` are written by the WhatsApp channel. `message` rows with origin
`SEED` are written here. Every conversation with no customer gets a generated
identity whose **primary phone is that conversation's own number**.

Consequences worth knowing before you run it:

- **A database with no conversations gets no cadastro and no messages from seed.**
  The seed completes and prints which demo roles it could not place.
- **Volume follows the conversations.** One identity and one `SEED` thread per
  1:1 chat. Re-running does not duplicate `SEED` rows.
- **`selectlub_realbase` must never be seeded.** `db:seed` refuses it by name.
  After the documented import, run `db:scrub-live` on the base so clones do not
  inherit real WhatsApp bodies. Clones then run `db:scrub-live` (if dirty) and
  `db:seed`.

Activity timestamps (`firstInboundAt`, `firstOutboundAt`, `lastInboundAt`,
`lastOutboundAt`, `lastMessageAt`) are taken from the `SEED` thread. Relatórios
after scrub+seed describe that fake exchange.

### Which database it writes to

`seed.ts` resolves `DATABASE_URL` through `resolveDatabaseTarget` (in
`packages/core/src/kernel/prisma/database-target.ts`) after loading the repo-root `.env` and
before constructing the Prisma client, and **refuses any host that is not
loopback**, exiting non-zero and naming the host. Unset, blank and malformed
values are refused too — it fails closed, so a value nobody anticipated cannot
land in the permitted branch. `SEED_ALLOW_REMOTE=1` is the deliberate override,
for a fresh deployed environment or a disposable preview database.

Every permitted run prints `seed: writing to <host>` first. On 2026-09-07 this
seed wrote the demo dataset into the hosted Supabase instance because the
repo-root `.env` named it, nothing checked the host, and nothing printed it;
the resulting figures then cost two sessions substantial time to reconcile.
Either the guard or the echo alone would have prevented that.

Because re-runs upsert rather than wipe, seeding an instance that already holds
rows leaves those rows in place and adds the demo set alongside them — which is
why the lead count afterwards was the sum of both, not the seed's own total.

A locally running worker may retry demo `queued` outbox rows against unknown Evolution instances — that is expected.

Oil-quote / catalog / Motul rows are seeded here now that those tables exist (GitHub #15). Attribution pairs are included so Relatórios funnel/KPIs have numbers.

### TIDSCI follow-on (not in this seed)

`pnpm --filter @select-lub/core tidsci:generate` with `TID_ARCHIVE_DATABASE_URL` and `OPENAI_API_KEY`, then `OMIE_MOCK=1` `OMIE_MOCK_DATASET=tidsci` and a worker mock pull. Batch ladder: `--limit 60` → 322 → 993 (3,286 keys; 60 cover half the invoice lines). Paths `.local/tidsci-omie-dataset.json` and `.local/tidsci-catalog-cache.json` are gitignored.
