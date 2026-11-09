# MVP — escopo e situação

**Evaluated against `86c65b2`** (`origin/main`, merge of PR #123), 2026-09-19.
The only change from `f9f0ff9`, where most of the checks below were run, is
#123's single worker test file — `git diff --name-only f9f0ff9 86c65b2` returns
one path — so every claim verified at that SHA still holds, and the ones dated
to it say so.

*Revision 3.* Revision 1 (PR #95) raised four findings, F1–F4; all four now have a
dated disposition below, with their original text kept so the trail stays
readable. Revision 2 was never merged on its own — its content is folded in
here, on top of main's H4 and H8 rows rather than beside them.

**Why this document exists at all**, kept from revision 1 because the answer has
not changed: before writing it I searched for an existing scope checklist to
extend instead — Notion (the *Hub de Especificações — CRM Select
Lub* tree and a workspace-wide search), `docs/`, `openspec/`, `artifacts/`, the
root README files, and every file ever added on any branch whose name contains
`scope`, `escopo`, `checklist`, `status` or `mvp`. None exists. The closest
things are `openspec-execution-order.md` (a 2026-08-28 ordering snapshot, now
historical) and `docs/schema_mvp.dbml` (a data model). A cloud session titled
"MVP feature scope checklist" is said to have run; it left no artifact in Notion
or in this repository that I could find.

## How to read this

The scope in Part 1 is **not invented here**. It is transcribed from the two
places the project already keeps it: the *Estado atual* section of the Notion
Hub ("Confirmado para o MVP" / "Fora do MVP"), and the `pos-mvp` GitHub label,
which is the boundary marker the issue tracker uses.

Every status in Part 2 names the thing that proves it. A spec directory, a test
file, a tour, a PR. A ticked box in a `tasks.md` is **not** evidence on its own —
the project spent 2026-09-17 finding out how unreliable that is — so where a tick
and the code disagree, this document follows the code.

| Status | Means |
| --- | --- |
| **Done** | Shipped on `86c65b2`, with a spec, automated tests, and either a browser tour or a written "manual only" reason in the tour ledger. |
| **Done, thin coverage** | The behaviour is shipped and works, but coverage has a hole the project has already named in writing. Listed individually in Part 3. |
| **In progress** | An active OpenSpec change with open tasks, or an open branch/PR. |
| **Not done** | No implementation on `main`. |

"Properly tested" uses the repo's own standard, not one invented here:
`apps/e2e/test/tours/README.md` (the coverage ledger, one row per capability,
with a stated reason wherever a tour is absent) and
`skills/testing-strategy/SKILL.md` (what tests each kind of change requires).

**OpenSpec state at `86c65b2`**, from `openspec list` rather than from memory —
27 capabilities under `openspec/specs/` and exactly **three** changes still
active:

| Change | Tasks | Note |
| --- | --- | --- |
| `oil-quote-retrieval-hardening` | 14/25 | Landed with #98 and left honestly incomplete |
| `close-stated-coverage-gaps` | 14/27 | Gated on task 1.5 — see **H1** |
| `compare-redesign-artboards-four-way` | 0/8 | **Cancelled 2026-09-27** by the owner; the change directory was deleted, never archived |

Anything else named in this document as a change is **archived**. That includes
six recently archived ones it would be easy to mistake for live work:
`route-tests-on-real-database` and `build-time-ui-variant` (2026-09-18 and
2026-09-17), and `live-scheduled-messages`,
`outbox-failures-are-visible-and-non-blocking`, `seed-fake-history-and-scrub-live`
and `seed-realistic-workshop-threads` (all 2026-09-16).

**Read this block with `git ls-tree`, not `ls`.** An archive leaves the change's
old directory behind on disk when a working copy still has untracked or ignored
files in it, so a directory listing shows archived changes as live — which is
exactly how the list in revision 3's first draft came to name five archived
changes as active. Git cannot represent an empty directory at all, so
`git ls-tree -d --name-only <sha> openspec/changes/` cannot show that residue,
and unlike `openspec list` it answers for a commit you are not checked out on,
which is what evaluating a SHA needs.

---

## Part 1 — What the MVP is

### In scope

From the Hub's *Estado atual*, "Confirmado para o MVP":

> Conversas, Follow-up, tags internas, cadastro compartilhado CRM–Omie com todos
> os campos exibidos editáveis, templates, programação manual e relatórios
> básicos.

Plus the surfaces and capabilities added to scope by later dated decisions on the
same page:

- **Tela de Serviços** (all customers) and **Tela de Veículo** — added
  2026-08-31 (#58, #59).
- **Tela de Follow-up** — added 2026-08-31 (#64).
- **Orçamento de troca de óleo**, priced per litre, grounded in citable sources —
  2026-09-09.
- **Consulta de placa** via APIBrasil `agregados-propria` — 2026-09-07.
- **Pré-preenchimento assistivo** behind a per-conversation switch, default off —
  2026-08-28, amended 2026-09-05.
- **shouldReply** / 60s silence window — 2026-08-31 (#50; the `pos-mvp` label was
  removed from that issue).
- **Auto-login** and the permission matrix per unit.
- **Design system** and the four/six MVP screens against the approved canvas,
  with the **PDF export** as the comparison reference (2026-09-07).
- **Publicação** of `apps/web`, `apps/api`, `apps/worker` on Fly.io `gru`, with
  the hosted WhatsEvolution Evolution instance.

Two scope constraints run through all of it:

1. **The MVP has no real Omie tenant.** Every Omie behaviour — cadastro,
   vehicles, services/OS, conflict pendings — runs on mocked data. Real-tenant
   validation is explicitly post-MVP (#27, #29).
2. **AI is assistive, never autonomous.** It suggests; an attendant accepts.

### Explicitly out

From "Fora do MVP" plus the `pos-mvp` label (15 open issues):

IA autônoma, gatilhos automáticos, Meta Conversions API, CRM operacional
avançado, citação no fio (#52), conversas de grupo (#51), fallback Cloud API
(#49), fallback de placa via API Placas, lista oficial de tags (#63), horário
comercial nas métricas (#62), adapters extras de fonte de óleo (#75), e os
padrões técnicos do canal (#8, #10, #44, #45, #46). Validação Omie real: #7,
#27, #29. Fusão de duplicados: #5.

---

## Part 2 — Item-by-item evaluation

### Conversas

| Item | Status | Evidence |
| --- | --- | --- |
| Inbox, busca, thread, envio, escopo por unidade | **Done** | `openspec/specs/conversas` (32 reqs / 114 scenarios); tours `conversas-inbox`, `conversas-cadastro`, `conversas-services`; e2e `conversas-inbox.spec.ts`, `conversas-send-text.spec.ts`; 9 `ConversasPage.*.test.tsx` |
| Nova conversa | **Done** | PR #89 (2026-09-17) — *Nova conversa resolves the same connection the rest of the app does*. The bug this fixed is the one **H8** is named after |
| Tags aplicadas e filtro | **Done** | `openspec/specs/tags-templates`; tours `configuracoes`, `conversas-inbox` |
| Ticks de status (enviado/entregue/lido/falha) | **Done** | #35/#54 closed; archived `2026-08-31-message-status-ticks-ui`; `apps/worker/src/ingest/status.test.ts` |
| Mídia sob demanda | **Done** | #34 closed; archived `2026-08-28-whatsapp-media-on-demand` |
| Histórico pré-CRM (backfill) | **Done** | #22 closed |
| Estado do canal e recusas quando desconectado | **Done** | `conversas-channel-down.tour.spec.ts` (PR #88). Runs under `pnpm test:e2e:tours:disconnected`, its own config |
| Recusa de `EVOLUTION_INSTANCE_NAME` não definido | **Done** | PR #91 |

### Cadastro compartilhado CRM–Omie

| Item | Status | Evidence |
| --- | --- | --- |
| Motor de conflito por campo, pendências | **Done (mock)** | `openspec/specs/omie-sync` (29 reqs / 82 scenarios); `conversas-omie.tour.spec.ts` (PR #88) — pins that the count is of **fields**, not customers |
| Fonte mock Omie com opt-in explícito | **Done** | `openspec/specs/omie-mock`; ledger: "manual only — a test double" |
| Painel de cadastro editável | **Done** | #33/#53 closed; archived `cadastro-panel-conflict-ui` |
| Veículos do cliente | **Done** | `openspec/specs/customer-vehicles`; tour `conversas-cadastro` |
| Serviços (OS) do cliente | **Done** | `openspec/specs/customer-services`; tours `conversas-services`, `servicos` |
| Consulta de placa | **Done, thin coverage** | `openspec/specs/plate-lookup` (13 reqs); tour `conversas-cadastro` covers mock hit and mock miss. See hole **H5** |
| Pré-preenchimento assistivo (ghost, aceitar/recusar) | **Done** | `openspec/specs/assistive-prefill`; ghost accept + dismiss toured (PR #88); PR #87 fixed the demo suggestion shape that 500'd |
| Validação contra Omie real | **Out of MVP** | #27, #29 — `pos-mvp` |

### Orçamento de óleo

| Item | Status | Evidence |
| --- | --- | --- |
| Preço por litro, composto editável, mensagem | **Done** | `openspec/specs/oil-quote` (14 reqs / 54 scenarios); archived `2026-09-09-oil-quote-liters-pricing` |
| Caminho de reuso (cache hit) | **Done** | PR #94 — toured in `conversas-oil-quote.tour.spec.ts`; ledger row updated 2026-09-17; its no-provider guard is **structural** (`mode=reuse` returns early) |
| Caminho `unavailable` e guarda de provider | **Done** | same tour file |
| Host de provider redirecionável | **Done** | PR #83; `MOTUL_DEFAULT_BASE_URL` / `TECFIL_DEFAULT_BASE_URL` in `packages/core/src/kernel/clients/motul/client.ts`, `packages/core/src/kernel/clients/tecfil/client.ts` (were `packages/motul`, `packages/tecfil` until `adopt-modular-vertical-slices`) |
| Schema aceita classificação vazia | **Done** | PR #93 / #86 |
| Caminho fresco (primeira consulta) — cards, edição de preço | **In progress** | `close-stated-coverage-gaps` **14/27**, tasks 1.2, 2.2, 3.2 open. Blocker cleared by PR #83; the task text still says otherwise — see **F1** |
| Caminhos `refetch` e edição de preço | **Not toured** | ledger row `oil-quote`, 2026-09-17: "Still untoured: the refetch branch… and price editing" |
| Busca na web como fallback da spec de óleo | **Done** | PR #98 landed the branch; `openspec/specs/oil-spec-web-search/` present on `main`. **No tour-ledger row yet** — see **H6**. Resolution of **F2** |
| Endurecimento da recuperação de fontes (retry, circuit breaker, cache de busca vazia, custo por consulta) | **In progress** | `oil-quote-retrieval-hardening` **14/25**, active on `main` since PR #98 |
| Catálogos Motul / Tecfil | **Done** | `motul-compatibility`, `motul-flatten`, `motul-recommendation`, `motul-client-resilience`, `tecfil-compatibility`, `tecfil-fitment`; ledger: "manual only — catalog data, no screen", unit-tested |

### Follow-up

| Item | Status | Evidence |
| --- | --- | --- |
| Quatro seções, contagens, arquivar | **Done** | `openspec/specs/follow-up` (9 reqs / 77 scenarios); `follow-up.tour.spec.ts`; `FollowUpPage.test.tsx` |
| Retornos de veículo vencidos / próximos | **Done** | `openspec/specs/vehicle-returns`; tours `conversas-services`, `follow-up` |

### Mensagens programadas

| Item | Status | Evidence |
| --- | --- | --- |
| Programar, cancelar, bloqueio por serviço ocupado | **Done** | `openspec/specs/scheduled-messages`; `conversas-schedule.tour.spec.ts`; e2e `conversas-schedule.spec.ts` |
| Disparo real no vencimento | **Done** | `apps/e2e/test/live/conversas-schedule-send.spec.ts`; archived `2026-09-16-live-scheduled-messages`. Live suite, quarantined from CI on purpose (sends real WhatsApp) |

### Relatórios

| Item | Status | Evidence |
| --- | --- | --- |
| KPIs, funil, origem, cobertura, faixa de alerta | **Done** | `openspec/specs/relatorios` (21 reqs / 102 scenarios); `relatorios.tour.spec.ts`; `RelatoriosPage.test.tsx` |
| Métricas restantes (REP-09/10) | **Done** | archived `2026-08-31-relatorios-remainder-metrics` **and** `-ui`. Issue #57 closed 2026-09-17 (**F4** resolved) |
| REP-11 / REP-12 (atribuição) | **Done** | `openspec/specs/relatorios`; #61 closed. API computes them; the screen section was deliberately removed by `align-shipped-ui-to-pdf-artboards` |
| Tempo corrido (não horário comercial) | **Done (by decision)** | horário comercial is `pos-mvp` (#62) |

### Plataforma

| Item | Status | Evidence |
| --- | --- | --- |
| Auto-login e matriz de permissão | **Done** | `openspec/specs/auth` (10 reqs); tours `app-shell`, `usuarios`; #41, #13 closed |
| Design system e as telas do MVP contra o PDF | **Done** | `openspec/specs/design-system` (50 reqs / 137 scenarios); archived `align-shipped-ui-to-pdf-artboards`; all six screens present with test files |
| Variante de UI em tempo de build (`cursor` / `antigravity`) | **Done** | Code: PR #85. Contract: PR #97 archived `build-time-ui-variant` — verified by spec **text**, not the archive directory: `antigravity` appears 12× in `openspec/specs/design-system/spec.md` and 8× in `openspec/specs/conversas/spec.md`. CI runs `test:web:antigravity`. Resolution of **F3** |
| Comparação quatro-vias dos artboards | **Cancelled** | `compare-redesign-artboards-four-way` cancelled by the owner 2026-09-27 at 0/8; no artifacts were produced |
| Publicação Fly.io + WhatsEvolution | **Done** | `openspec/specs/deploy` (14 reqs); #40, #21 closed; ledger: "manual only — infrastructure" |
| Seed de demo | **Done, thin coverage** | `openspec/specs/demo-seed` (24 reqs); 39 test files, formerly `packages/db`, now under `packages/core` (`src/kernel/prisma`, `prisma/seed`). See hole **H4** |
| Contratos compartilhados | **Done** | `openspec/specs/shared-types` (39 reqs / 146 scenarios) |
| Fundação do repositório e regras de teste | **Done, thin coverage** | `openspec/specs/repo-foundation` (**23 reqs** — 21 plus the three deltas #121 merged, which is how the archive was verified); PR #92 serialised the live DB tests. Issue #25 open |
| Suítes de rota contra o banco real (fim dos fakes em memória) | **Done** | `route-tests-on-real-database` — waves 1–4 merged, PRs #102 through #120; every in-memory store deleted and `buildApp` now requires a database. Archived by **#121** at `openspec/changes/archive/2026-09-18-route-tests-on-real-database/`, and its three deltas are in `openspec/specs/repo-foundation/spec.md` — verified by the requirement count moving 21 → 23, not by the directory move. Closes **H8** |

---

## Part 3 — Findings that need a decision

These are the things a status table cannot carry. Each is a divergence between
what a record says and what `main` actually contained when it was raised. All
four have a disposition as of `86c65b2`; the original text is kept and the
outcome follows it.

### F1 — `close-stated-coverage-gaps` tasks are blocked on something that already landed

Tasks 1.2, 2.2, 3.2 and 5.3 all read **"BLOCKED until `MOTUL_BASE_URL` and
`TECFIL_BASE_URL` are on this branch."** They landed on 2026-09-17 in PR #83 and are on
`main`: `packages/motul/src/client.ts:14` and `packages/tecfil/src/client.ts`
export the default constants, and `apps/e2e/tours-config.shared.ts` already
references them. The blocker is cleared; the tasks still say otherwise. The
change is 9/26 and the remaining fresh-path oil-quote work is unblocked.

**Disposition (`f9f0ff9`): partially resolved, and the stale text is still
there.** The change moved to **14/27**, but task 1.2 on `main` still opens with
"BLOCKED until `MOTUL_BASE_URL` and `TECFIL_BASE_URL` are on this branch" —
checked at this SHA, not inferred. Recorded so the next reader does not take
that line at face value.

### F2 — A capability the Notion Hub records as shipped is not on `main`

The Hub's entry dated **14 de setembro de 2026** says:

> OpenSpec `oil-spec-web-search` arquivada (commit `f798129`); nova capability
> `oil-spec-web-search` em `openspec/specs/`.

`openspec/specs/oil-spec-web-search/` does **not** exist on `origin/main`, and
commit `f798129` is **not an ancestor of `main`**. Both live only on
`origin/claude/active-sessions-pending-tasks-a7b368`, which carries **22 commits
not on main** — the web-search source adapter, its two insert-only ledgers,
search-miss caching, a Motul circuit breaker, bounded retry, and per-query cost
logging.

This matters for scope because the 2026-09-09 decision made the oil quote depend
on a grounded source pipeline, and web search is that pipeline's documented
fallback step. Issue **#77** (ingesting PDF manuals) is also written against
`web-search-source-adapter` and is therefore blocked on the same branch.

Two readings, and I cannot settle which from the specs: either that branch is
still expected to merge and the Hub was written ahead of the merge, or the work
was abandoned and the Hub needs correcting. **Routed to the orchestrator.**

**Disposition (2026-09-17): resolved — the first reading was right.** The owner
decided the branch was still meant to merge; the Hub had been written ahead of
the code. PR #98 brought the 22 commits over. Verified at `f9f0ff9`:
`openspec/specs/oil-spec-web-search/` is present, `openspec/specs/` now holds
**27** capabilities, and the accompanying `oil-quote-retrieval-hardening` is
left honestly **active at 14/25** rather than archived as complete. Issue #77 is
no longer stranded; it now follows that change.

### F3 — A complete change never reached the shipped contract

`build-time-ui-variant` is 19/19 and its code is on `main`. But it is not
archived, so its spec deltas were never merged: `openspec/specs/design-system`
has no variant requirement, and `openspec/specs/conversas` contains no mention of
`antigravity`, the icon rail, or the four-column layout. The shipped contract
does not describe shipped behaviour, which is exactly the situation the change's
own *Why* section set out to prevent ("neither redesign's behaviour is written in
any spec, so the next Conversas change cannot know which layout it must keep
working").

**Disposition (2026-09-17): resolved.** PR #97 archived the change and synced
its deltas. Verified by the check that matters — the spec text, not the
directory move: `antigravity` appears 12× in `openspec/specs/design-system/spec.md`
and 8× in `openspec/specs/conversas/spec.md`, where before it appeared 0× in
both. **H7** closes with it.

### F4 — Issue #57 is stale and should close

It says it is tracked by `relatorios-remainder-metrics-ui` at **0/4 tasks** and
that **#39 remains open**. Both are wrong: the change is archived at
`openspec/changes/archive/2026-08-31-relatorios-remainder-metrics-ui/`, and #39
is CLOSED. It is the only `relatorios` issue still open and it makes the
Relatórios screen look unfinished when it is not.

**Disposition (2026-09-17): resolved.** #57 closed with a note pointing at the
archived change and the closed issue. No `relatorios` issue remains open.

### Named coverage holes ("done but not properly tested")

| # | Hole | Where it is written down |
| --- | --- | --- |
| **H1** | `pnpm test:e2e` intermittently red on `main`. **Revised:** revision 1 of this row repeated task 1.5's hypothesis — the seed racing in-flight requests. Measurement on 2026-09-17 ruled that out; database contention, connection exhaustion and unit resolution were each excluded with evidence. Three fixes landed: **#96** (each local run gets its own database, as CI already had), **#99** (wait for the schedule dialog to close), **#100** (retry a connection dropped at start of run). Two residual mechanisms remain and are **local Windows artifacts, not suite defects**: a first-burst stall below the web server (`WSAENOBUFS`; survives removing Vite entirely, so it would not occur on CI/Linux) and Docker Desktop's loopback forwarder dropping the seed's connection in the first seconds. The product-side fetch timeout in **#101** mitigates the stall and must not be described as fixing it. | Project memory `e2e-residual-stall-is-below-the-web-server`; task 1.5 still open — the tour suite is the local browser gate meanwhile |
| **H2** | Oil quote: the **refetch** branch and **price editing** are untoured. | `apps/e2e/test/tours/README.md`, `oil-quote` row, 2026-09-17 |
| **H3** | The off-box-host guard for tours has **never been seen fail**. A guard with no red run is not evidence. | `close-stated-coverage-gaps` task 5.3, open |
| **H4** | ~~The reports live tests **leak a unit per run** — 204 orphan units in one worktree DB by 2026-09-17.~~ **Closed 2026-09-18** by PR #107: `reports.seeded-period.live.test.ts` deleted its connection in teardown but never its unit; it does now, and three runs leave the unit count unchanged. | `apps/api/src/reports.seeded-period.live.test.ts` |
| **H5** | Until PR #84 (2026-09-17), the tour stack blanked `PLACAS_TOKEN` — a name nothing in the repo reads — while `resolvePlacasAccess` reads `APIBRASIL_BEARER_TOKEN` and resolves credentials *before* the mock opt-in. The cadastro tour was hitting the real, credit-metered APIBrasil. It cost nothing only because both plates were already cached. Fixed; noted because it is the pattern, not the instance. | `apps/e2e/test/tours/README.md` |
| **H6** | The tour ledger's **last full pass is still 2026-09-10**, now thirty-odd merges ago. And the ledger has **26 rows for 27 spec directories**: `oil-spec-web-search` (PR #98) has neither a tour nor a "manual only" reason, while the ledger's own rule is that every spec directory appears. Both checked at `f9f0ff9`. | `close-stated-coverage-gaps` task 4.2, open; `apps/e2e/test/tours/README.md` |
| **H7** | ~~Build-time UI variant behaviour is in no spec.~~ **Closed 2026-09-17** by PR #97 — see F3. | — |
| **H8** | **Found 2026-09-18** by the coverage audit behind revision 2 of this document: ~~every store had an in-memory fake beside its Prisma adapter and nothing checked they agreed — no suite ran one set of tests against both. They did not agree. `Conversation` has no `unitId` column at all: the adapter scopes by joining `whatsappConnection`, while the fake compared a flat field it invented. Uniqueness is `[whatsappConnectionId, chatKey]`; the fake deduped on unit + phone, which agrees only while a unit has one connection. Cadastro's fake had no `versionWhere`, so the dual-change guard was tested without the concurrency it exists for, and the outbox had no fake at all. 23 of 24 route tests ran on the fakes, so #89 (Nova conversa resolving a different connection from the rest of the app) lived in a concept they could not represent and stayed green throughout. Mocking was never the problem — 3 of 270 files mocked a module; the doubles modelled a shape the database does not have.~~ **Closed 2026-09-18** by `route-tests-on-real-database`: every store-touching suite runs on the real adapter inside a rolling-back transaction and the fakes are deleted. PRs #102 (harness), #103, #104, #105, #107, #108, #109, #110, #111, #112 (waves 2 and 3), #113 and #118 (wave 3.5, the latter carrying #114 #115 #116 #117 #119), and **#120** (wave 4, which deletes every in-memory store and makes `buildApp` require a database), archived by **#121**. | `openspec/changes/archive/2026-09-18-route-tests-on-real-database/`, with its deltas in `openspec/specs/repo-foundation/spec.md` |
| **H9** | **Twelve live suites sit outside the harness** — ten `apps/api/src/*.live.test.ts` plus `apps/worker/src/ingest.live.test.ts` and `ingest/status.live.test.ts`. They were deliberately out of `route-tests-on-real-database`'s scope, so they keep the old model: they run against the shared database without a rolling-back transaction, and eight of the twelve resolve the WhatsApp connection by **instance name**, so two of them running at once contend for the same row. ~~`ingest.live.test.ts` additionally has an **answer-before-finish race** — it asserts on a result the ingest path may still be writing.~~ **That half closed 2026-09-19 by PR #123**, which made the test wait on `markEvent` — the pipeline's own completion signal, explicitly "not a sleep and not a poll" — before asserting. The route still answers before canonicalization finishes, deliberately; it was the test that was wrong, not the behaviour. Worth recording because the race was found here by reading, then proved itself by failing CI on an unrelated docs-only diff before anyone set out to reproduce it. **The twelve-suites half stays open**: still twelve suites and still eight resolving by instance name, re-counted at `86c65b2`. A hole unrelated to H8's adapter drift. **Paths moved, 2026-09-24:** after `adopt-modular-vertical-slices` the app live suites are `apps/api/test/*.live.test.ts` (seven) and `apps/worker/test/ingest.live.test.ts` (one), eight where there were twelve. Where the other four went, and the harness and instance-name claims, were not re-checked at that move. | `apps/api/test/*.live.test.ts`, `apps/worker/test/ingest.live.test.ts`; PR #123 |
| **H10** | ~~**`reports.live` flakes under default Vitest concurrency**, green at `--maxWorkers=2`, measured independently by three streams during wave 3.5 and read as the cost of moving every store-touching suite onto one database.~~ **Closed 2026-09-19 as a misdiagnosis.** The mechanism was measured rather than inferred: four `apps/api` suites run at once against four separate databases, one failing inside a route's `client.service.findMany()` with `Can't reach database server at 127.0.0.1:5433`. It is the Docker Desktop loopback forwarder dropping a connection under local load, the same artifact as #100 and the one wave 4 wrapped for the harness; the live suites call the shared client directly and are not covered, so the dropped query surfaces through HTTP as a 500. Three facts settle it: the Postgres container logged nothing, because the connection never arrived; a full suite peaks at 21 of 100 connections and `too many clients` has never appeared; and **CI has never seen it**, verified by grepping the failed runs' logs for these files and for the connection error, with no hit. (The red job on main is `deployed-schema-drift`. An earlier revision said it failed on a missing secret; that was read off the workflow's guard text rather than the job log. The secret is configured and connects to the session pooler. What it reports is real drift: see **H11**.) `--maxWorkers=2` narrowed the window rather than fixing a defect. No worker cap and no production change. Two real defects were found instead, both fixed: `apps/api` and `apps/worker` ran their live files in parallel under a package-scoped gate while the root script CI runs serializes them; and the connect-retry added in wave 4 matched only `PrismaClientInitializationError`, while the drop that fails a live suite arrives as `PrismaClientKnownRequestError`, so it never fired. The predicate now keys on the message across Prisma's error classes and the twelve live suites wrap the shared client with it. Measured after: eight serialized live passes, three of which hit a drop and retried, all eight green. | Project memory `transactional-suites-flake-live-tier`, corrected |
| **H11** | ~~The **deployed database is two migrations behind main**~~ **Closed 2026-09-19**, applied by the owner with `prisma migrate deploy` against the session pooler. It had been missing: `20260910020000_oil_spec_web_source` and `20260914120000_oil_source_candidates_and_misses`. Both are additive, two columns on `motul_compatibility` plus the two oil-source ledger tables and their indexes, with no destructive statement in either. The deployed API therefore runs against a schema without the web-search source columns or the candidate and miss ledgers, so anything writing them fails there while passing locally and on CI. Both were applied on 2026-09-19. Worth keeping rather than deleting: the Fly deploy does **not** run migrations, so a schema change reaches production only when someone runs it deliberately, and nothing but this job reports the gap. | `deployed-schema-drift` job output, CI run 35435823733, 2026-09-19 |

---

## Part 4 — Open MVP-scope issues

Six issues are open **without** the `pos-mvp` label and without "PÓS-MVP" in the
title, re-queried at 2026-09-19 rather than carried over. #57 closed
since revision 1; #106 is new. Everything else open is out of scope by decision.

| # | Title | Read |
| --- | --- | --- |
| [#25](https://github.com/ga-rodrigues-dev/select-lub-crm/issues/25) | [37] Finish hardening testing rules | Process, not product. Folds remaining course criteria into the testing skills. |
| [#28](https://github.com/ga-rodrigues-dev/select-lub-crm/issues/28) | [35] Medir custo do pré-preenchimento automático | Never measured. The per-conversation switch (default off) reduced the urgency but did not answer it. |
| [#48](https://github.com/ga-rodrigues-dev/select-lub-crm/issues/48) | Parear número real do cliente para demo | Manual human step (QR scan). Not code. Gates a "real" demo. |
| [#76](https://github.com/ga-rodrigues-dev/select-lub-crm/issues/76) | `Vehicle.version` conflates trim and engine | Real modelling defect. Plate lookup writes a **trim** (`EX CVT`); Motul and Tecfil both key on an **engine**. Affects oil-quote and filter lookup accuracy. |
| [#77](https://github.com/ga-rodrigues-dev/select-lub-crm/issues/77) | Ingest manufacturer manuals (PDF) | No longer stranded (F2 resolved by #98). Follows `oil-quote-retrieval-hardening`, 14/25. |
| [#106](https://github.com/ga-rodrigues-dev/select-lub-crm/issues/106) | Omie mock pull never dedupes duplicate-candidate rows: `SyncRunStore.errors()` is a stub | Found by stream 3B during the test migration. The dedupe it gates is **dead code in production**, so duplicate-candidate rows grow unbounded. Mock-only today, but the same path is what a real tenant would use. |

---

## Summary

Against `86c65b2`, the MVP as the project defines it is **substantially
complete**. All **27** capabilities under `openspec/specs/` are implemented; 26
have either a browser tour or a written reason why a tour cannot reach them, and
the 27th (`oil-spec-web-search`) is missing only its ledger row. Roughly forty
PRs merged across 2026-09-17 and 2026-09-18, #83 through #120.

**All four findings this document opened are now closed**, which is the main
thing revision 3 records:

- **F2** was the largest record-vs-code gap: a 22-commit branch the Notion Hub
  already described as shipped. It is on `main` (#98).
- **F3** and **F4** were bookkeeping and are done (#97 with the spec text
  verified, not just the directory move; #57 closed).
- **F1** is resolved in fact but **not in text** — the task still says BLOCKED.

Two of the coverage holes also closed, and the way they closed is worth keeping:
**H4** (the leaking unit) turned out to be a teardown that deleted the connection
but not the unit, and **H8** — adapter drift, found by this document's own audit
— became `route-tests-on-real-database`, four waves and roughly twenty PRs that
deleted every in-memory store. **H1** turned out to be a different problem than
its task text claimed, and what remains of it is a local Windows artifact that
does not affect CI.

What is genuinely left:

- **Two product defects**: #76 (`Vehicle.version` conflating trim and engine,
  degrading oil and filter accuracy) and #106 (a stub making the Omie dedupe
  dead code).
- **Two active changes** that landed honestly incomplete rather than pretending
  otherwise: `oil-quote-retrieval-hardening` 14/25 and
  `close-stated-coverage-gaps` 14/27.
- **Two open coverage holes**: the ledger's stale full pass and missing row
  (H6), the twelve live suites still outside the harness (H9, whose
  answer-before-finish half closed with PR #123 while the twelve-suites half
  stays open). H10, the `reports.live` flake, closed on 2026-09-19 once its
  mechanism was measured: a dropped Docker loopback connection under local
  load, never seen on CI, not the concurrency defect three streams inferred.
  H9 is a **consequence of the H8 work** — it moved the ordinary suites onto
  the real database and left the live tier where it was. H9 is also the clearest
  argument for writing these down: it was found by reading those twelve files,
  and then failed CI on an unrelated docs-only pull request before anyone went
  looking for it.
- **One research change, cancelled** (`compare-redesign-artboards-four-way`,
  0/8, cancelled by the owner 2026-09-27), never MVP scope.

Nothing in the confirmed MVP scope is unimplemented. The remaining risk is still
**coverage and record-keeping** rather than missing features — and after two days
it is mostly coverage, in a narrower and better-understood set of places than
when this document was first written.
