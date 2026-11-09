# api

Typed CRM HTTP client. `../api.ts` re-exports these functions so page imports stay on `./api.js`.

- **http.ts** — `apiBase`, session headers, JSON `parse`, Content-Disposition filename
- **conversations.ts** — list, create, messages, channel status
- **send.ts** — outbound text and media
- **vehicles.ts** — conversation customer/vehicles, patches, Omie pendings
- **services.ts** — OS list GETs (conversation, vehicle, unit)
- **quote.ts** — quote options and persist; the refetch, the kept fill volume and the engine pick (background-oil-research D16, D24)
- **prefill.ts** — suggestion get/accept/reject/retry
- **tags.ts** — tags, templates, apply, preview
- **scheduled.ts** — list/create/cancel and suggest-date
- **reports.ts** — Relatórios and Follow-up GETs
- **auth.ts** — `/auth/me` and user admin
