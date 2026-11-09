# Table ownership

## The manifest

`ownership.json` at the repository root assigns every table to exactly one
module, and says who may read it:

```json
"plate-lookup": {
  "tables": ["plate_lookup", "plate_lookup_call"],
  "readableBy": "*"
}
```

Names are **table** names — the Prisma `@@map` value — not model names. The two
differ throughout: `WhatsAppConnection` maps to `whatsapp_connection`.

`readableBy` is `"*"` everywhere today. Narrowing one is deliberate: every read
the removed module still makes starts failing with `permission denied` as soon
as the grants are regenerated. That is the point — a read nobody should be doing
fails loudly instead of quietly returning rows.

## From manifest to enforcement

`pnpm gen:grants` turns the manifest into two files, neither edited by hand:

- `db/grants.generated.sql` — one `module_<name>` role per module, `REVOKE ALL`
  then `GRANT SELECT` on readable tables and `GRANT INSERT, UPDATE, DELETE` on
  owned ones. Membership is granted to `current_user` through
  `EXECUTE format(...)`, so the file works whichever role `DATABASE_URL` names;
  per-worktree databases differ.
- `packages/core/src/kernel/db.modules.generated.ts` — `ModuleName`, `OWNED` and
  `roleFor`, so `db.tx` takes a name the compiler knows.

`pnpm db:migrate` applies the SQL after
`prisma migrate deploy`. It reapplies on every run: a database migrated before
the roles existed would otherwise fail at the first `db.tx` with
`permission denied to set role`.

## At runtime

```ts
await db.tx("plate-lookup", async (tx) => { /* ... */ });
```

`db.tx` opens a transaction, takes a savepoint, issues
`SET LOCAL ROLE module_plate_lookup`, runs the callback, and restores the role
afterwards. Inside it, a write to a table `plate-lookup` does not own is refused
by Postgres — through Prisma, through raw SQL, and through code nobody has
written yet.

The savepoint is not decoration. The refusal is a failed statement, and a failed
statement puts Postgres into `25P02`, where even `RESET ROLE` fails and its
error replaces the `permission denied` the caller was meant to see. Rolling back
to the savepoint clears that state and restores the role together.

## Under the test harness

The rollback harness runs each test inside a transaction it never commits, and
hands slices `runInTransactionOnTx`, so a slice's `db.tx` joins the test's
transaction rather than opening a nested one Prisma would reject. Two
consequences, both accepted:

- A slice's transaction is **not independently atomic** under the harness. Its
  writes roll back with the test's.
- The role must be restored before the test's own assertions run, or the test's
  seeding would execute as the module role and fail on the first foreign table.

Seeds, the harness itself, `scrub-live.ts` and the e2e fixtures write across
module lines by design. They run as the login role, never call `db.tx`, and are
listed under `exemptPaths` in the manifest.

## What keeps it honest

Three tests in `packages/core/test/`:

| test | fails when |
| --- | --- |
| `grants.test.ts` | the generated files are stale against `ownership.json` |
| `schema-ownership.test.ts` | a model sits in the wrong module's schema file, or an owned table has no model |
| `roles.test.ts` | a foreign write is *not* refused, or the login role is not restored |

`roles.test.ts` is the load-bearing one. It writes raw SQL on purpose: raw SQL
is the case a lint rule or an arch test scanning ORM calls could never catch,
and if the refusal holds there it holds for Prisma a fortiori.
