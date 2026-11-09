# web/src

Attendant UI. Server data via TanStack Query; local UI via Zustand.

- **ConversasPage.tsx** — Conversas composition root at `/` (inbox + thread + rail)
- **uiVariant.ts** / **screens.ts** — the build-time variant (`cursor` | `antigravity`, from `VITE_UI_VARIANT`) and the six-screen list both navs read

### The two UI variants

`X.tsx` is a **selector**: it imports `X.cursor.tsx` and `X.antigravity.tsx` and
exports whichever the build chose. Every consumer and every test keeps importing
`X.js` and gets the active one, so the variant never appears in an import path
outside these trios.

Behaviour lives in the shared modules; a `*.cursor.tsx` / `*.antigravity.tsx`
file only **arranges** what is already there. A date rule, a query, a mutation or
a pure helper belongs in `helpers.ts`, `api.ts` or its own module — never in a
variant file, where it would have to be written twice and would eventually
differ. That is why `prefill.tsx` and `vehicles.tsx` are split per component
rather than per file: only three of their fifteen exports actually differ.

The two variants MUST agree on accessible names, Portuguese copy, test ids and
routes. That agreement is what lets one behavioural suite run in both modes with
no `UI_VARIANT` branch in it. Chrome that genuinely exists in one variant only
gets its own `*.antigravity.test.tsx`, skipped in the other mode.

- **conversas/** — inbox, thread, cadastro rail, vehicles, quote, schedule, prefill
- **api.ts** / **api/** — HTTP client barrel and per-resource modules
- **ServicosPage.tsx** — unit-wide OS listing at `/servicos`
- **FollowUpPage.tsx** — operational lists at `/follow-up`
- **RelatoriosPage.tsx** / **ConfiguracoesPage.tsx** / **UsuariosPage.tsx** / **Gallery.tsx** — other screens
- **assembleOilQuoteMessage.ts** — oil-change proposal text from `template.md`
- **oilCardName.ts** — an oil card's title and message option name (brand, description, viscosity) and the pt-BR oil-type labels
- **useNow.ts** — the app's ticking clock (`useNow`) and the server-offset clock (`useServerNow`) that a counter anchored on a server instant reads
- **PageShell.tsx** / **LabeledField.tsx** — the screen pages' shared frame (nav, grey ground, borderless `cardSx`, heading-above-card `PageSection`) and label-above form fields
- **App.tsx** / **AppProviders.tsx** / **RequireAuth.tsx** / **main.tsx** — routes, Query/theme, gate (skip link to `#conteudo-principal`)
- **theme.ts** / **paletteStore.ts** / **authSession.ts** / **selectionStore.ts** — tokens, palette switch, JWT, selected conversation
