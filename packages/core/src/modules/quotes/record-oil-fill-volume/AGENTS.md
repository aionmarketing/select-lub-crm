# record-oil-fill-volume

**Purpose.** "Guardar para este modelo" (background-oil-research D24.1, `quotes/oil-attendant-fill`):
keep the fill volume an attendant typed on a missing-volume quote for the vehicle's identity, so
later quotes of the same car model are priced from it, flagged as the attendant's.

**Kind.** HTTP route — `POST /vehicles/:id/oil-fill-volume`, body `{ liters, confirmHighVolume? }`.
Entry points: `recordOilFillVolume(db, input)` and `route()`, which `createHttpPlugin` mounts.

**Tables written** (`quotes`-owned, one `db.tx("quotes", …)`): `oil_attendant_fill`, one inserted
row. **Tables read:** `vehicle`, `customer` (unit scope), `user` (the author's name).

**Invariants.**
- `liters` > 0 with at most two decimals, else 400; above 30 L only with `confirmHighVolume: true`,
  else 422 `{ warning: "high_volume" }`; an incomplete identity is 409 `{ reason: "incomplete_identity" }`.
- Insert-only; the latest row per identity is the one read (`internal/store/attendant-fill.ts`).
- Writes no cache row, grade source or research row, and calls no provider. Research never reads it.
- 404 alike for an unknown vehicle and another unit's.

**Tests.** `tests/record-oil-fill-volume.integration.test.ts` (module role `quotes`, rolling back).
