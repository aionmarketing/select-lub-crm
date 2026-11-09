# accounts / list-units

**Purpose.** `GET /units`: the lojas the caller belongs to, each with a display
name. Follow-up prints the scoped loja's name from it; Usuários offers the
others as choices.

**Kind.** HTTP query.

**Tables written.** None. Tables read: `unit` (accounts' own), under
`module_accounts`.

**Invariants.**

- Scoped by the caller's **memberships** (`crmUnitIds`), not by `X-Unit-Id`;
  the loja the header selects is always in the list, so a screen can name it.
- The `select` names exactly `id` and `name`.
- Ordered by name in the database's collation.
- An id with no `unit` row is dropped, never returned nameless; an empty
  request matches nothing.
- The path stays `/units`, and `/units` stays in the hook's
  `API_PATH_PREFIXES`: a GET path missing there skips JWT validation.

**Tests.** `tests/list-units.integration.test.ts`. The hook's 401/403 for this
path are in `apps/api/test/accounts.integration.test.ts`.
