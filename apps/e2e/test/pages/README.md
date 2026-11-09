# e2e/test/pages

Page objects: semantic locators (`getByTestId`, then role and label), not CSS
classes. Shared by the default suite (`test/*.spec.ts`) and the exploratory
tours (`test/tours/*.tour.spec.ts`) — a tour is a file, not a second framework.

- **app-shell.ts** — header, palette switch, navigation rail, Follow-up badge,
  `main` landmark; the chrome every route shares
- **conversas-page.ts** — inbox, list item, composer, schedule, cadastro on `/`
- **servicos-page.ts** — read-only OS list, filters, and detail pane on
  `/servicos`
- **follow-up-page.ts** — the four counted cards, section regions, and per-entry
  actions on `/follow-up`
- **relatorios-page.ts** — period filters and the six metric regions on
  `/relatorios`
- **configuracoes-page.ts** — Tags and Templates catalogs and their create forms
  on `/configuracoes`
- **usuarios-page.ts** — team table, unit editing, and the create form on
  `/usuarios`

## Locator notes

`input[type=date]` has no `textbox` role, so the period filters (`De`, `Até`,
`Início`, `Fim`) are located with `getByLabel`. Everything else on these screens
is reachable by role, which is why these objects added no new `data-testid` to
`apps/web`.

`usuarios-page.ts` carries a standing caution: completing its create form makes a
real Supabase Auth account, and the tour stack shares the project's Supabase, so
tours use the seeded users and the form's refusal paths only.
