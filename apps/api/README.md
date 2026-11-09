# api (`@select-lub/api`)

Fastify HTTP API. Auth, Conversas, cadastro, reports, tags. Can serve the built SPA.

- **src/** — the `buildApp` composition root: each module's `httpPlugin`, the auth hook, `/health` and the SPA, all from `@select-lub/core`
- **test/** — how suites use the worktree's Postgres through the rollback harness, and the gate (see `test/README.md`)
- **dist/** — compiled output; do not edit
