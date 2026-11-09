# lookup-plate

**Purpose.** Resolve a Brazilian plate to suggested vehicle fields (make, model,
version, year, displacement, fuel) for the vehicle form. Suggestions only: this
slice never writes `vehicle` or `customer`.

**Kind.** HTTP route, `POST /plate-lookups`. Authenticated by `apps/api`'s hook,
because `/plate-lookups` is in `resolve-unit.ts`'s prefix list. No unit-ownership
check — a plate is not owned by a shop — but the caller's unit is recorded on each
billed hop so spend is attributable.

**Tables written** (both owned by `plate-lookup`, under `db.tx("plate-lookup", …)`):

- `plate_lookup` — the cache, one row per normalized plate: a resolution or a miss.
- `plate_lookup_call` — the ledger, one row per billed provider hop.

**Ports.** `plateProvider: PlateProvider | null`, closed over by `route(ports)`.
`null` means the feature is inactive and the route answers `unavailable`. The slice
never constructs a provider; the "omitted means production" fallback lives only in
`apps/api`'s `buildApp`.

## Invariants

1. **The provider call runs in no transaction, and each query runs in its own.**
   A billed hop is committed the moment it is recorded, before the cache write.
   Wrapping the lookup in one `db.tx` would let a failed cache write roll back the
   ledger row for a charge the provider has already made.
2. **Nothing reaches the provider unless the plate parses and the cache cannot
   answer.** A malformed plate is a 422; a cached resolution, or a cached miss
   without `retry: true`, is served without a call.
3. **A mock answer is neither cached nor ledgered.** A later credentialed lookup
   must reach the provider rather than be served the mock's fields.
4. **A failure is ledgered but not cached**, so the next lookup tries again.
5. **Owner-identifying keys are stripped** from the raw payload before it is stored.
6. **Anything but `"miss"` in `plate_lookup.outcome` is a resolution**, exactly as
   the adapter this replaced read it. The production writer uses `"resolved"`. The
   demo seed used to write `"found"`; #132 corrected it, but a database seeded
   before that and not re-seeded still holds `"found"` rows (W2-C8). Tighten the
   read only once no such rows can exist.
