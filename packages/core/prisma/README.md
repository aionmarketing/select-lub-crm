# db/prisma

Physical schema. Conceptual source of truth remains Notion Modelagem de Dados.

- **schema/** — the schema, split one `<module>.prisma` per module in
  `ownership.json`, plus `schema.prisma` for the datasource and generator.
  Prisma reads the folder as a single schema; every CLI call passes
  `--schema prisma/schema`. Which models may live in which file is checked by
  `packages/core/test/schema-ownership.test.ts`.
- **seed.ts** — units, WhatsApp connection name, optional Auth user ids
- **migrations/** — timestamped SQL (do not add a README per folder)

`../prisma.config.ts` points `migrations.path` back here. Without it a folder
schema makes Prisma look for migrations _inside_ `schema/`, and `migrate deploy`
reports "No pending migrations to apply" against an empty database.
