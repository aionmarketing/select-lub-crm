# Architecture

The repository is a **modular monolith of vertical slices**. Three documents:

- [`modules-and-slices.md`](./modules-and-slices.md) — what a module is, what a
  slice is, and the scopes between them.
- [`table-ownership.md`](./table-ownership.md) — how ownership is declared and
  why the database, rather than review, is what enforces it.
- [`../stacks/typescript-fastify-prisma-postgres.md`](../stacks/typescript-fastify-prisma-postgres.md)
  — how the general rules bind to this repository's stack.

The rules are conventional. The enforcement is the part worth reading: every
module has a Postgres role, and a slice's transaction runs as that role, so a
write to a table the module does not own fails in the slice's own test, in CI,
and in production alike.
