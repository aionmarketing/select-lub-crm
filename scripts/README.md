# scripts

Repository tooling: scripts that act on the repo itself rather than on any one
workspace package.

- **gen-grants.ts** — turns `ownership.json` into `db/grants.generated.sql` (the
  eleven `module_<name>` Postgres roles and their grants) and into
  `packages/core/src/kernel/db.modules.generated.ts`. Run it with
  `pnpm gen:grants`; `--check` diffs instead of writing, and
  `packages/core/test/grants.test.ts` is that check.
