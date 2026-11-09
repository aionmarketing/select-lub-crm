# accounts / create-user

**Purpose.** `POST /users`: create a person who can sign in — a Supabase Auth
user, then the CRM `user` row with its initial lojas.

**Kind.** HTTP command, with one outbound port (`createAuthUser`).

**Tables written.** `user`, `user_unit`, both accounts' own, under
`module_accounts`.

**Invariants.**

- **The provider call is never inside `db.tx`.** Supabase first, then the CRM
  user and its memberships in one `db.tx`. In production `db.tx` runs on
  `prisma.$transaction` with a 5 s timeout, and the harness (60 s, instant
  fakes) would not show a provider call eating it.
- The CRM user and its memberships commit together: a loja with no `unit` row
  rolls the user row back too (500), so no user exists without the lojas it was
  created with.
- A loja named twice in `unitIds` is stored once (`distinctUnitIds`). It used to
  hit `user_unit`'s primary key, and that P2002 read as "e-mail taken".
- 409 with `{}` when the e-mail is taken — whether Supabase says so
  (`isAuthDuplicateEmail`) or the CRM `user` table does (Prisma `P2002`).
- The response never carries the password or the service-role key.
- The path stays `POST /users`. The hook's `isUnitExemptPath` matches it
  literally, so a caller need not send `X-Unit-Id` here.

**Known gap, unchanged from `apps/api`.** If Supabase creates the user and the
CRM write then fails, the Auth user stays with no CRM row. Nothing compensates
it, as before. Widening the transaction around the provider call is not the fix
(see the first invariant); a compensating delete through the Auth Admin API, or
an idempotent retry keyed on the Auth id, would be.

**Known gap, recorded for the owner.** Nothing restricts who may create users:
any caller with a verified token can. No requirement says otherwise yet.

**Tests.** `tests/create-user.integration.test.ts`. The create → attach →
detach flow, where the hook then admits and refuses the created user, is in
`apps/api/test/accounts.integration.test.ts`; the committed-row duplicate count
is in `apps/api/test/auth.users.live.test.ts`.
