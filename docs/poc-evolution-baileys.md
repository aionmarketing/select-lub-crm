# PEND-CH-01 — Evolution API + Baileys POC

Protocol for GitHub #3. Pair a **dedicated Select Lub test WhatsApp** (production attendant number only if no test line exists). Filling the results tables and the go/no-go is **HUMAN-ONLY** (physical phone). Implementation leaves this file with empty tables.

> **Historical note (2026-08-30):** the local Compose Evolution stack described below was removed from the repo — Evolution now runs on a hosted provider (WhatsEvolution), reached via `SERVER_URL`. The `docker compose --profile local-evolution` commands and `127.0.0.1:8080/8081` URLs no longer work here; they record how the POC ran. The REST bodies (instance create, `webhook/set`, `settings/set`) and the findings tables remain valid against the hosted host.

Image tags: `evoapicloud/evolution-api:v2.3.7`, `evoapicloud/evolution-manager:v2.3.5`.

The API process also serves a manager UI at [http://127.0.0.1:8080/manager](http://127.0.0.1:8080/manager). The standalone Manager container on port 8081 is pinned as specified; `v2.3.5`'s own nginx config has an invalid `gzip_proxied` value (`invalid value "must-revalidate"`) that used to crash-loop it. `docker-compose.yml` now mounts `docker/evolution-manager/nginx.conf` (the same file with `must-revalidate` dropped) over the image's copy, so 8081 serves normally; REST or the bundled `/manager` still work as alternatives.

Do not commit QR images, pairing codes, webhook secrets, or full message bodies.

## 0. Start the stack

CRM Postgres only (default; Evolution services use the `local-evolution` profile):

```bash
cp .env.example .env   # if needed; then replace AUTHENTICATION_API_KEY and EVOLUTION_WEBHOOK_SECRET
openssl rand -hex 32   # paste into both secret vars
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev:worker
```

Local Evolution (do **not** start this profile while the same WhatsApp number is paired on a hosted Evolution host):

```bash
docker compose --profile local-evolution up -d
```

- Evolution API: [http://127.0.0.1:8080](http://127.0.0.1:8080)
- Bundled manager: [http://127.0.0.1:8080/manager](http://127.0.0.1:8080/manager)
- Worker webhook: `POST http://127.0.0.1:3001/webhooks/evolution`
- CRM Postgres stays on host port **5433**

From a **local** Evolution container the webhook URL is `EVOLUTION_WEBHOOK_URL` (`http://host.docker.internal:3001/webhooks/evolution`).

### Hosted Evolution API v2 (inbound tunnel)

A remote Evolution host cannot reach `host.docker.internal`. Point `.env` at that host (`SERVER_URL`, instance `AUTHENTICATION_API_KEY`, unencoded `EVOLUTION_INSTANCE_NAME` — spaces allowed). Leave `WORKER_HISTORY_BACKFILL` unset. Worker timers use the same names as `.env.example`: `WORKER_HEARTBEAT_MS` (default 30000), `WORKER_OUTBOX_POLL_MS` (default 1000), `WORKER_OUTBOX_CLAIM_TIMEOUT_MS` (default 180000 — abandoned `claimed` outbox rows older than this become `failed` with `send_outcome_unknown`, never `queued`; keep it above the 120000 ms media send limit). [GitHub #21](https://github.com/ga-rodrigues-dev/select-lub-crm/issues/21) (production hosting of Evolution and the worker) stays open.

1. Worker listening on `127.0.0.1:3001`.
2. `cloudflared tunnel --url http://127.0.0.1:3001` (quick tunnel; the hostname changes on every restart).
3. Set `EVOLUTION_WEBHOOK_URL` in local `.env` only (not git) to `https://<tunnel-host>/webhooks/evolution`.
4. Confirm the tunnel reaches the worker with an **unauthenticated POST** of `{}` (no `Authorization` header). A **401** from the worker is success. The route is POST-only — a GET would 404 even when the tunnel works. Connection refused or timeout is failure.
5. Register the webhook (`byEvents: false` is load-bearing: when true, Evolution appends the event name to the URL and the worker's single `POST /webhooks/evolution` route misses events):

```bash
curl -s -X POST "$SERVER_URL/webhook/set/$(node -e "process.stdout.write(encodeURIComponent(process.env.EVOLUTION_INSTANCE_NAME ?? ''))")" \
  -H "Content-Type: application/json" \
  -H "apikey: $AUTHENTICATION_API_KEY" \
  -d "{
    \"webhook\": {
      \"enabled\": true,
      \"url\": \"$EVOLUTION_WEBHOOK_URL\",
      \"byEvents\": false,
      \"base64\": false,
      \"headers\": {
        \"Authorization\": \"Bearer $EVOLUTION_WEBHOOK_SECRET\"
      },
      \"events\": [
        \"QRCODE_UPDATED\",
        \"CONNECTION_UPDATE\",
        \"MESSAGES_SET\",
        \"MESSAGES_UPSERT\",
        \"MESSAGES_UPDATE\",
        \"SEND_MESSAGE\"
      ]
    }
  }"
```

6. `GET $SERVER_URL/webhook/find/{percent-encoded EVOLUTION_INSTANCE_NAME}` must return that same URL, not `host.docker.internal`. When the tunnel URL changes, run `webhook/set` again.

**Where events land now:** new authenticated webhooks are stored in CRM Postgres (`webhook_event`, and 1:1 `messages.upsert` / `send.message` also in `conversation` / `message`). `artifacts/evolution-webhooks/` is leftover from the POC file sink and is **not** the source of truth. The results tables below remain the historical PEND-CH-01 run (they still say “sink” because that is how that run was recorded). Pre-CRM history is still REST `findMessages` / `findChats` (PEND-CH-07), not pairing `messages.set`. Do not set `WORKER_HISTORY_BACKFILL=1` for the hosted trial.

## 1. Create a Baileys instance and register the webhook

**Every new pair** (another test line, a re-pair, or the production Select Lub number) MUST send `"syncFullHistory": true` on `POST /instance/create`. Compose `SYNC_FULL_HISTORY=true` is only the process default. Current pair (2026-08-26): test line **19000000002** (`5519000000002`), instance `select-lub-poc`, `syncFullHistory: true`. The original PEND-CH-01 tables below are the previous unnamed test line (flag false).

```bash
curl -s http://127.0.0.1:8080/instance/create \
  -H "Content-Type: application/json" \
  -H "apikey: $AUTHENTICATION_API_KEY" \
  -d '{
    "instanceName": "select-lub-poc",
    "integration": "WHATSAPP-BAILEYS",
    "qrcode": true,
    "syncFullHistory": true
  }'
```

Register the webhook so Evolution sends `Authorization: Bearer <EVOLUTION_WEBHOOK_SECRET>` (v2.3.7 does not add an auth header by default):

```bash
curl -s http://127.0.0.1:8080/webhook/set/select-lub-poc \
  -H "Content-Type: application/json" \
  -H "apikey: $AUTHENTICATION_API_KEY" \
  -d "{
    \"webhook\": {
      \"enabled\": true,
      \"url\": \"http://host.docker.internal:3001/webhooks/evolution\",
      \"byEvents\": false,
      \"base64\": false,
      \"headers\": {
        \"Authorization\": \"Bearer $EVOLUTION_WEBHOOK_SECRET\"
      },
      \"events\": [
        \"QRCODE_UPDATED\",
        \"CONNECTION_UPDATE\",
        \"MESSAGES_SET\",
        \"MESSAGES_UPSERT\",
        \"MESSAGES_UPDATE\",
        \"SEND_MESSAGE\"
      ]
    }
  }"
```

Compose sets `SYNC_FULL_HISTORY=true` as the Evolution process default. The create body still needs `"syncFullHistory": true` — Evolution stores that flag on the instance, and the POC instance was created with it **false**. Toggling later:

```bash
curl -s http://127.0.0.1:8080/settings/set/select-lub-poc \
  -H "Content-Type: application/json" \
  -H "apikey: $AUTHENTICATION_API_KEY" \
  -d '{
    "rejectCall": false,
    "msgCall": "",
    "groupsIgnore": false,
    "alwaysOnline": false,
    "readMessages": false,
    "readStatus": false,
    "syncFullHistory": true
  }'
```

That updates Evolution's setting. It does **not** re-download WhatsApp history for an instance that already completed its first sync. Deeper history needs a **new** instance created with `syncFullHistory: true` (or a fresh pair). REST `findMessages` can only return what Evolution already stored.

Scan the QR (or use a pairing code) on the phone. Confirm the instance is open/connected via `GET /instance/connectionState/select-lub-poc`. QR material must not appear in git, CRM tables, or worker logs.


| Field                                          | Value                                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Number used (test line / production attendant) | test line **19000000002** (current pair 2026-08-26; PEND-CH-01 tables below are the previous unnamed test line)              |
| Pairing method (QR / code)                     | QR                                                                                                                           |
| Time to `CONNECTED`                            | ~4s (last `qrcode.updated` 14:51:12Z → `state: open` 14:51:16Z)                                                              |
| QR/pairing seen in git, CRM, or worker logs?   | no (worker stdout is event/instance/id only; `artifacts/evolution-webhooks/` is gitignored; no conversa/mensagem tables yet) |




## 2. Drop connection and restart without wiping volumes

Disconnect on purpose (close WhatsApp, toggle phone network, and/or `docker compose restart evolution-api` **without** `docker compose down -v`). Record whether a new QR was required.


| Field             | Value                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| Disconnect method | `docker compose restart evolution-api` (volumes kept)                                                   |
| Time to reconnect | ~2s handshake (`connecting` 12:06:45 → `open` 12:06:47); ~13s from restart command until `open` webhook |
| New QR required?  | no                                                                                                      |




## 3. History depth

After pairing, note how much history Evolution surfaces (`MESSAGES_SET` or equivalent) in `artifacts/evolution-webhooks/`.


| Field                                  | Value                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| History event name                     | `messages.set` (Evolution v2); REST `POST /chat/findMessages/{instance}` also stores history after pairing                                                                                                                                                                                                                                                                                                         |
| Approximate messages / chats recovered | Webhook at pairing: 96 messages / 19 chats in the first `messages.set` (~129 KiB), then 3 empty `messages.set`. Evolution DB after pairing: **2936 messages / 24 chats** (`findMessages` total=2936, 59 pages of 50; `findChats` count=24).                                                                                                                                                                        |
| Notes                                  | `syncFullHistory` was false on instance create. Later pairing-time `messages.set` batches were dropped with Fastify **413** (1 MiB default). Worker `bodyLimit` is now 50 MiB; a later `docker compose restart evolution-api` did **not** re-emit `messages.set` (history webhook is pairing-time, not restart). Sample of stored types on page 1: conversation, image, document, audio, video, sticker, protocol. |

**How the CRM uses this (product, 2026-08-25):** live 1:1 traffic is `messages.upsert` / `send.message` into CRM `Conversation`/`Message` (GitHub #4). Pre-CRM history is **not** taken from pairing `messages.set` (incomplete vs Evolution's own store: 96/19 vs 2936/24; 413s; no replay on restart). Backfill pages Evolution REST `POST /chat/findMessages/{instance}` and `POST /chat/findChats/{instance}` into the same unique key as live ingest ([GitHub #22](https://github.com/ga-rodrigues-dev/select-lub-crm/issues/22), PEND-CH-07). Relatórios filter by `first_inbound_at` from `providerTimestamp` (WhatsApp's timestamp, not ingest time), so a 2024 first inbound does not count as an August 2026 new conversation; a 2026 reply to an unanswered 2024 inbound still counts as first-response using those real timestamps.




## 4. Repeated 1:1 text

Send and receive several texts. Each should appear on the far-end phone. The table below is the historical file-sink run; new events go to CRM tables. Process logs must show only `event`, `instance`, and `externalMessageId` — not the body.


| Direction                          | Sent | Received on phone   | Sink events                                    | Duplicates | Lost                                              |
| ---------------------------------- | ---- | ------------------- | ---------------------------------------------- | ---------- | ------------------------------------------------- |
| Outbound (Manager / API)           | 4    | 4 (operator)        | 4 `send.message` (fromMe, source=web)          | 0          | 0 at webhook; all 4 arrived on the far-end phone |
| Outbound (test phone)              | 4 (retest) + 2 earlier | not confirmed here | 4 + 2 `messages.upsert` (fromMe, source=android) | 0 | 0 at webhook (6/6); **none** in Manager UI |
| Inbound (other number → test line) | 4    | 4 on the test phone | 4 `messages.upsert` (fromMe=false, source=web) | 0          | 0 at webhook; **none** in Manager UI              |


Manager at `http://127.0.0.1:8080/manager/` is **not** a reliable inbox: inbound texts and messages typed on the test phone did not appear there, but the worker got inbound `messages.upsert` and **all** phone-typed outbound texts in this run (2 then a 4-message retest). CRM Conversas must follow the webhook sink (and later the DB), not the Manager chat list. Sending **from** Manager/API reached the far-end phone and produced 4/4 `send.message` sink events.

Process logs for this run stayed at `event` / `instance` / `externalMessageId` only.

## 5. Media

Attempt image, audio, and document send/receive. Record success or the limitation (type, size, missing download).


| Type          | Send                                                                                                                                           | Receive                                                                        | Sink event? | Limitation                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image         | yes (Manager `send.message`, jpeg ~154 KiB)                                                                                                    | yes (`messages.upsert` fromMe=false, jpeg ~146 KiB)                            | yes both    | Webhook has CDN `url`/`directPath`, **no** `base64` or `mediaKey` (`base64: false` on register). CRM will need Evolution's media-download API to persist bytes. |
| Audio         | yes (REST `POST /message/sendWhatsAppAudio/select-lub-poc`, not Manager). `send.message` audio/ogg PTT ~29 KiB, 1s. Far-end phone received it. | yes (`messages.upsert` fromMe=false, audio/ogg PTT ~3 KiB, 1s)                 | yes both    | Manager UI cannot send audio. Same missing `base64`/`mediaKey`; `url`/`directPath` present.                                                                     |
| Document      | yes (Manager `send.message`, pdf ~109 KiB)                                                                                                     | yes (`messages.upsert` fromMe=false, pdf ~2.0 MiB, sink JSON ~275 KiB, no 413) | yes both    | Same missing `base64`/`mediaKey` as image. Filename present.                                                                                                    |
| Video (extra) | yes (Manager `send.message`, mp4 ~4.0 MiB)                                                                                                     | yes (`messages.upsert` fromMe=false, mp4 ~4.0 MiB, 17s)                        | yes both    | Same download-metadata limitation. Not required by the protocol table; recorded because it was sent both ways.                                                  |


**What “missing download” means:** WhatsApp does not put the file bytes in the webhook. The event is a *pointer*: mimetype, size, and a short-lived `url` / `directPath` on WhatsApp’s CDN. This run registered the webhook with `"base64": false`, so Evolution also omitted `base64` and (here) `mediaKey`. Saving the JSON in `artifacts/evolution-webhooks/` does **not** store the image/pdf/audio. Conversas fetches bytes on demand via Evolution `POST /chat/getBase64FromMediaMessage/{instance}` while the instance is connected; the CRM does not archive attachments. Turning `"base64": true` would embed files in every webhook and would make large media/history POSTs even more likely to hit size limits (we already 413’d history at 1 MiB). CDN URLs expire; do not treat `url` as durable.

## 6. Events observed

Tick what landed in the sink:

- [x] `CONNECTION_UPDATE` (`connection.update`)
- [x] `QRCODE_UPDATED` (`qrcode.updated`)
- [x] `MESSAGES_UPSERT` (`messages.upsert`)
- [x] `MESSAGES_UPDATE` (`messages.update`)
- [x] `SEND_MESSAGE` (`send.message`)
- [x] `MESSAGES_SET` (`messages.set`)

- Other: Fastify `413` `FST_ERR_CTP_BODY_TOO_LARGE` on large pairing-time history POSTs (before worker `bodyLimit` was raised to 50 MiB).



## Go / no-go


| Field | Value |
| --- | --- |
| Decision (go / no-go) | **go** for Evolution API + Baileys as the MVP WhatsApp channel (GitHub #3 / PEND-CH-01). |
| Number used | dedicated Select Lub **test line 19000000002** (not the production attendant number). Current pair 2026-08-26 with `syncFullHistory: true`. |
| Image tags | `evoapicloud/evolution-api:v2.3.7`, `evoapicloud/evolution-manager:v2.3.5` |
| Limits and risks observed | Baileys is unofficial (WhatsApp can break pairing/protocol). Session survived `docker compose restart evolution-api` (~2s handshake, no new QR). Manager UI is not an inbox: inbound text/media and phone-typed outbound often do not appear there; worker webhooks did. Outbound from Manager/REST reached the far-end; 4/4 Manager texts produced a `send.message` sink file. Phone-typed outbound in this run: 2 then 4 sent, 6 in sink (0 lost). History: pairing `messages.set` kept 96 msgs/19 chats then 413s; Evolution DB had 2936 msgs/24 chats; restart does not re-emit `messages.set`. Media types (image/audio/document/video) send+receive worked; webhook has CDN pointers not file bytes — ingest must call `getBase64FromMediaMessage`. Manager cannot send audio (REST can). Standalone Manager `v2.3.5` on :8081 crash-loops (use `/manager` or REST). Worker `bodyLimit` is 50 MiB (Fastify default 1 MiB 413'd history). `syncFullHistory` was false. |

