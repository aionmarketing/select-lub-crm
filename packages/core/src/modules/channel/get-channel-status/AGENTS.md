# get-channel-status

**Purpose.** Tell the Conversas screen whether the WhatsApp channel is up, for its
Conectado / Desconectado badge.

**Kind.** HTTP route on the api's app, `GET /channel/status`, mounted by the module's
`createHttpPlugin({ instanceName })`. Entry points: `route(deps)`,
`getChannelStatus(db, instanceName)`.

**Tables written.** None. Reads `whatsapp_connection` under `db.tx("channel", …)`.

**Invariants.**

- Reads the STORED `connection_state` of the one configured instance
  (`EVOLUTION_INSTANCE_NAME`), the same row Nova conversa checks — never the live probe,
  which only the send paths read.
- No row for that name reads `DISCONNECTED`.
- The path is unchanged; `apps/api`'s auth hook still special-cases it.

**Tests.** `tests/get-channel-status.integration.test.ts`, 2 cases moved from
`apps/api/src/conversations/prisma.test.ts`. The cases behind the auth hook stay in
`apps/api/src/conversations.test.ts`.

**Blocked on core.** Nothing.
