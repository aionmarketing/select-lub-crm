# accounts / set-user-units

**Purpose.** `PUT /users/:id/units`: replace a CRM user's loja memberships
with the set sent. The Usuários screen's assign/unassign.

**Kind.** HTTP command.

**Tables written.** `user_unit` (delete the user's rows, insert the new set).
Tables read: `user`. Both accounts' own, under `module_accounts`.

**Invariants.**

- The body is the **complete** new set, not a delta. Any membership not sent
  is removed — which is why `GET /users` must return each user's whole set.
- The lookup and the replacement are one transaction. A loja with no `unit`
  row is refused by the foreign key and nothing changes (500).
- An id with no CRM `user` row is 404 with `{}`, and nothing is written.
- The path stays `/users/:id/units`. The hook's `isUnitExemptPath` matches it
  literally, so a caller need not send `X-Unit-Id` here.
- Nothing yet restricts which users a caller may edit, nor which lojas they
  may hand out. No requirement asks for it; this slice does not invent one.

**Tests.** `tests/set-user-units.integration.test.ts`. The detach half of the
create → attach → detach flow, where the hook then refuses the detached user,
is in `apps/api/test/accounts.integration.test.ts`.
