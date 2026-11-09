# Tour run — Disconnected WhatsApp channel (what the screen refuses, and what it offers instead)

## Feature

Conversas with the unit's Evolution instance `DISCONNECTED`: what the attendant
can no longer do, the Portuguese reason given, and the manual fallback offered
in place of sending.

Change under tour: `close-stated-coverage-gaps`, tasks 1.4 and 2.3.

## Tool and build

| What | Value |
| --- | --- |
| Browser tool | **Playwright MCP** (`@playwright/mcp`), role-based snapshots |
| Tour stack | API `127.0.0.1:3101`, SPA `127.0.0.1:5175`, mock Evolution `127.0.0.1:18082` |
| `EVOLUTION_INSTANCE_NAME` | `e2e-canal-desconectado` — **the whole point of this stack** |
| Provider guard | shared with every tour via `tours-config.shared.ts` |
| Worker | not started |
| Database | per-worktree local Postgres |
| Seed | task 1.4: a second connection `DISCONNECTED`, its own customer, conversation and one done service |

**Why this tour has its own config.** `channelStatus()` resolves the connection
by `EVOLUTION_INSTANCE_NAME` (`conversations/prisma.ts:454`) — one CONFIGURED
instance, not "whichever connection belongs to this unit". So the state the
refusals depend on is a property of the API PROCESS. Seeding a second connection
alone changes nothing the screen reads; flipping the shared connection would
break every other tour. A separate process pointed at a disconnected instance is
the only option that leaves the rest of the suite alone.

## Tours

- **Guiado (Negócio)** — the attendant arrives to a channel that is down. What
  are they told, and what are they offered instead?
- **Rumo Errado (Negócio)** — try the two things the spec says must be blocked:
  send, and schedule.
- **Correios (Negócio)** — the fallback is a link out to WhatsApp Web. Does
  taking that route leave the CRM claiming it sent something?

## Guidebook

- `openspec/specs/conversas/spec.md` — the screen shows the instance state as one
  of four values; composer send and any schedule control MUST be blocked with a
  Portuguese reason when the state is not `CONNECTED`; when `DISCONNECTED` the UI
  SHALL offer opening the conversation on WhatsApp Business Web; using that
  fallback MUST NOT mark an outbox item or canonical message as sent by the CRM.
  Also: "Boolean `connected: false` is not sufficient: the four-state value MUST
  be what the UI reads."

## Steps

| # | Action | Observation | Oracle | Result |
| --- | --- | --- | --- | --- |
| 1 | Open the inbox against the disconnected stack | Header reads `Desconectado`, not a generic offline indicator | conversas — the screen shows the instance state as one of the four values | succeeded |
| 2 | Open the disconnected conversation | The composer is **not disabled — it is absent**. In its place an alert: `Envio pelo CRM indisponível.` | conversas — composer send is blocked with a Portuguese reason | succeeded |
| 3 | Read the alert's offer | A link `Abrir no WhatsApp` to `https://web.whatsapp.com/send?phone=11999000009` — the conversation's own number | conversas — when `DISCONNECTED` the UI offers WhatsApp Business Web | succeeded |
| 4 | Look for the schedule control | `Programar mensagem` is present and enabled on the customer's service | conversas — the control is still offered; the block is on confirming | succeeded |
| 5 | Activate it | The dialog opens, and `Confirmar` is **disabled**, carrying the same reason: `Envio pelo CRM indisponível.` | conversas — any schedule control is blocked with a Portuguese reason | succeeded |
| 6 | Read the database back | 1 message on that conversation, the seeded inbound. **0** outbox rows, **0** scheduled messages | conversas — using the fallback must not mark an outbox item or message as sent by the CRM | succeeded |

## Diagnosis

**The schedule refusal is at the CONFIRM, not at the trigger**, and that is worth
stating because the obvious assertion is wrong. `Programar mensagem` stays
enabled and the dialog still opens; what is blocked is `Confirmar`. A tour
asserting that the trigger is absent or disabled would fail against correct
behaviour.

**The composer is absent rather than disabled.** So a tour must assert its
absence, not `toBeDisabled()` — the latter fails on an element that is not there.

**The fixture needed a SERVICE, and finding that out is why this was driven
first.** On the first pass the customer had no services, so the rail showed an
empty `Mensagens programadas` and there was no schedule control at all. A
"scheduling is blocked" assertion would have passed on that fixture for the
wrong reason — nothing to schedule is not the same as scheduling refused. The
seed now gives this customer one done service so the control exists to be
blocked.

**No defect.** Both refusals are implemented, both state a Portuguese reason, and
the fallback writes nothing.

## Findings

| # | Kind | What | Where it went |
| --- | --- | --- | --- |
| 1 | fixture design — resolved before transcription | A disconnected-channel fixture needs a service, or the schedule refusal cannot be distinguished from a customer with nothing to schedule. | Seed gives the customer one done service; the reason is in the fixture comment. |
| 2 | design correction | Decision 7 said a second connection in a non-`CONNECTED` state would isolate the refusal paths. It cannot: `channelStatus()` reads ONE configured instance name, so the row is invisible to the screen. It is also unsafe — `create()` (Nova conversa) resolves the unit's connection with `findFirst({ where: { unitId } })` and no ordering, so an extra connection joins an unordered pick that `conversas-inbox.tour.spec.ts` depends on. Measured: that unit already holds two connections and `findFirst` returns the one that is NOT configured; they agree today only because both are `CONNECTED`. | Decision 7 amended; the divergence is production code and was reported for placement. |

## Transcribed to

`conversas-channel-down.tour.spec.ts` — task 3.3, run by
`playwright.tours-disconnected.config.ts`. Only the steps marked succeeded, each
`expect` citing the `conversas` scenario named in its row.
