# Modules and slices

## Module

A module is a vertical piece of the product that **owns tables**. It is not a
layer and not a folder of related code: it is a name in `ownership.json` with a
list of tables beside it, and the only thing allowed to write them.

There are eleven: `accounts`, `channel`, `conversations`, `customers`,
`prefill`, `services`, `scheduling`, `quotes`, `plate-lookup`, `reports`, `erp`.
Three of them are transports rather than domains — `channel` is the only thing
that talks to WhatsApp, `erp` the only thing that talks to the ERP, and
`scheduling` owns deferred sends.

A module lives at `packages/core/src/modules/<module>/` and has three scopes:

| scope | who may import it |
| --- | --- |
| `contracts/` | any module, and `packages/shared-types` |
| `internal/` | this module's own slices |
| `<slice>/` | nobody |

`index.ts` exports `httpPlugin(app)` and/or `jobs(register)`, and is the only
file the composition roots import.

## Slice

A slice is **one use case**: one route, or one worker loop. A verb-named folder,
entered only through its `index.ts`, which exports the handler, the route or job
definition, and the request and response schemas.

A slice starts as a single file. When any file in it passes 300 lines the linter
fails and the slice splits into fixed parts — `schema.ts`, `handler.ts`,
`rules.ts`, `queries.ts`, `<dependency>.ts` — with `index.ts` as the barrel.
`handler.ts` is capped at 60 lines, because a handler is glue: parse, call the
rules, map the result. `rules.ts` is pure; the clock, the database and the
network arrive as arguments.

`utils`, `helpers`, `common`, `types`, `misc` and `lib` are banned as file and
folder names. A part is named after what it does.

Each slice has one integration test in `tests/`, exercising the handler through
`index.ts` against the real database inside the rollback harness, under the
module's role. The test imports the slice's entry point or its rules, nothing
else.

## Crossing a boundary

Two channels, and for any pair of modules only one of them:

- **A contract function** on the owning module's `contracts/`, for a request
  aimed at that module — `channel.enqueueOutbound`, `customers.applyPrefillSuggestion`.
- **An event**, whose schema lives in the producer's `contracts/`, for when the
  producer should not know its consumers — `conversations/message-received`.

Never another module's `internal/`, never another slice, never another module's
handler. The linter rejects the import; the database rejects the write.

## Why the shape

Three properties fall out of it, and none of them depend on anyone remembering:

1. **A change has one place.** A use case is a folder; adding one adds a folder.
2. **Coupling is visible.** A module's public surface is the contents of one
   directory. If two modules are entangled, the `contracts/` folder says so.
3. **Ownership is checkable.** Not by convention or by an arch test scanning ORM
   calls — regex over queries is fragile and this repository has been bitten by
   it — but by the database refusing the statement.
