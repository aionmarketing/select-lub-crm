# accounts / get-me

**Purpose.** `GET /auth/me`: the caller's id, e-mail, name, every unit they
belong to, and the unit they are working in when that resolves.

**Kind.** HTTP query.

**Tables written.** None. Tables read: none — the answer comes from the
`request.crm*` fields that `apps/api`'s auth hook loaded from `user` and
`user_unit` (through accounts' `createCallerDirectory`).

**Invariants.**

- The path stays `/auth/me`. The hook's `isUnitExemptPath` matches it
  literally; a renamed path would start demanding `X-Unit-Id` and a caller with
  two lojas could no longer learn which ones to pick from.
- `currentUnitId` is **omitted**, never `null`, when it does not resolve: the
  header is not a membership, or there are several memberships and no header.
- `currentUnitId` comes from the hook's own rule, the kernel's
  `resolveCurrentUnit` (`kernel/auth/resolve-unit.ts`). This slice kept a copy
  while the hook lived in `apps/api`; since the cleanup after wave 5 it calls the
  kernel's, so `/auth/me` and the hook cannot drift apart.
- `name` falls back to the e-mail when the caller has no CRM name.

**Tests.** `tests/get-me.integration.test.ts`. The hook's 401/403 are in
`apps/api/test/accounts.integration.test.ts`.
