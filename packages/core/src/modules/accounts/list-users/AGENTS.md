# accounts / list-users

**Purpose.** `GET /users`: the team list on the Usuários screen — every CRM
user who shares a loja with the caller, each with all of their lojas.

**Kind.** HTTP query.

**Tables written.** None. Tables read: `user`, `user_unit` (accounts' own),
under `module_accounts`.

**Invariants.**

- Scoped by the caller's **memberships** (`crmUnitIds`), not by `X-Unit-Id`:
  the list is the same whichever held loja the header selects.
- A listed user's `unitIds` is their **whole** membership set. Never add a
  `where` to the nested `units` select: the screen would read a short list and
  the next `PUT /users/:id/units` would delete the lojas it never saw.
- The `select` names exactly `id`, `email`, `name` and the memberships, so a
  column added to `user` later cannot reach the client.
- Ordered by name in the database's collation; `unitIds` has no order.
- An empty filter matches nobody.
- The caller is a `user` row too, and appears in its own list.

**Tests.** `tests/list-users.integration.test.ts`. The hook's 401/403 for this
path are in `apps/api/test/accounts.integration.test.ts`.
