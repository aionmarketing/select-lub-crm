/**
 * Test design (testing-strategy)
 *
 * SUT: `buildVehicleOmieSync` in `omie-sync.ts` — the pure rollup that turns a
 *   vehicle's per-field `VehicleFieldSync` rows and its OPEN
 *   `VehicleReconciliationPending` rows into the one state a screen shows.
 *   Both adapters delegate to it, so its branches are the read model's branches.
 *
 * Oracle: `customer-vehicles` delta of `align-shipped-ui-to-revised-canvas`,
 *   requirement "A vehicle's Omie synchronisation state is readable" — the four
 *   states, a failure carrying its reason and the time of that attempt, a
 *   conflict carrying both values per field, and the mapping never presented as
 *   confirmed while GitHub #29 is open. The ranking between states (conflict
 *   first) is the user's decision of 2026-09-03, recorded on the schema.
 *
 * Axes
 *   A1 omieId          — set / null
 *   A2 open pendings   — none / one / several
 *   A3 field results   — none / all "ok" / at least one "failed"
 *   A4 attempt times   — none recorded / one / several
 *   BVA on A4: the rollup picks a maximum and the failure picks a latest, so
 *   each ordered comparison is sampled with the newer row FIRST and with it
 *   SECOND — a `>` written as `>=`, or an argument order swapped, survives only
 *   one of the two.
 *
 * Outputs
 *   O1 state "never_synced" with omieId null
 *   O2 state "synced" with the omieId and the latest attempt
 *   O3 state "failed" with the failing fieldKey, its reason, latest attempt
 *   O4 state "conflict" with every field, each carrying both values
 *   O5 mappingConfirmed false — on every state, never true
 *
 * Sampled cells (one row per `it`)
 *   no omieId, no rows          | A1 null, A2 none, A3 none | O1 O5
 *                                 | fails if an unsynced vehicle reads as synced
 *   omieId, all ok              | A1 set, A3 ok, A4 several | O2
 *                                 | fails if the attempt is not the newest
 *   one failed field            | A3 failed                 | O3
 *                                 | fails if the reason or the field is dropped
 *   failed with no reason       | A3 failed, lastError null | O3 reason null
 *                                 | fails if a null reason becomes a string
 *   conflict beats failure      | A2 one, A3 failed         | O4
 *                                 | fails if the ranking puts failure first
 *   failure beats synced        | A1 set, A3 failed         | O3
 *                                 | fails if an omieId short-circuits to synced
 *   conflict with no omieId     | A1 null, A2 one           | O4 omieId null
 *                                 | fails if conflict requires an omieId
 *   two conflicting fields      | A2 several                | O4 both fields
 *                                 | fails if only the first field is returned
 *   latest failure, newer 2nd   | A3 two failed, BVA        | O3 second reason
 *   latest failure, newer 1st   | A3 two failed, BVA        | O3 first reason
 *   failure with no attempt time| A4 one null               | O3
 *   both failures undated       | A4 none                   | O3 first, null time
 *
 * Decision / branch map
 *   `attempts.length === 0 ? null : reduce`
 *     T — no-rows `it` and the both-undated `it`; F — every dated `it`
 *   `(a, b) => (a > b ? a : b)` inside that reduce
 *     T — all-ok `it` (newer first); F — same `it` (newer second). Both orders
 *         appear in that one row's data, which is what makes the comparison,
 *         not the input order, responsible for the result
 *   `openPendings.length > 0`
 *     T — the four conflict its; F — every other
 *   `row.lastResult === "failed"` filter
 *     T — the failure its; F — all-ok `it` (rows present, none failed) and
 *         no-rows `it` (nothing to filter)
 *   `best === null` in the failure reduce
 *     T — every failure `it` on its first row; F — the two-failure its
 *   `row.lastAttemptedAt === null`
 *     T — no-attempt-time `it` (candidate undated, incumbent dated)
 *     F — the two dated-failure its
 *   `best.lastAttemptedAt === null`
 *     T — both-undated `it` is F on this and reaches the final compare;
 *         the no-attempt-time `it` covers T by ordering the dated row second
 *     F — the two dated-failure its
 *   `row.lastAttemptedAt > best.lastAttemptedAt`
 *     T — newer-second `it`; F — newer-first `it`
 *   `latestFailure !== null`
 *     T — the failure its; F — all-ok and no-rows its
 *   `vehicle.omieId !== null`
 *     T — all-ok `it`; F — no-rows `it`
 *
 * Out of scope, with reason
 *   - Which fields may belong to a vehicle: `assertOwnerField` in the memory
 *     store already refuses a person key on a vehicle owner, and this function
 *     ranks whatever rows it is handed rather than re-validating them.
 *   - Resolved (closed) pendings: the port contract says the caller passes OPEN
 *     rows only, so a resolved row never reaches this function.
 */
import { describe, expect, it } from "vitest";
import { buildVehicleOmieSync, vehicleOmieSyncSchema } from "./http.omie-sync.js";

const vehicle = { id: "veh-1", omieId: "omie-77" };
const unlinked = { id: "veh-1", omieId: null };

function syncRow(over: {
  fieldKey: "plate" | "make" | "model" | "odometerKm";
  lastAttemptedAt?: string | null;
  lastResult?: string | null;
  lastError?: string | null;
}) {
  return {
    fieldKey: over.fieldKey,
    lastAttemptedAt: over.lastAttemptedAt ?? null,
    lastResult: over.lastResult ?? null,
    lastError: over.lastError ?? null,
  } as const;
}

describe("buildVehicleOmieSync", () => {
  it("reports never synchronised for a vehicle with no Omie id and no rows", () => {
    const state = buildVehicleOmieSync(unlinked, [], []);

    expect(vehicleOmieSyncSchema.parse(state)).toEqual({
      vehicleId: "veh-1",
      mappingConfirmed: false,
      state: "never_synced",
      omieId: null,
    });
  });

  it("reports synchronised with the most recent attempt across its fields", () => {
    const state = buildVehicleOmieSync(
      vehicle,
      [
        // Newest first, then oldest, so the maximum cannot come from position.
        syncRow({ fieldKey: "plate", lastResult: "ok", lastAttemptedAt: "2026-08-30T10:00:00.000Z" }),
        syncRow({ fieldKey: "make", lastResult: "ok", lastAttemptedAt: "2026-07-01T10:00:00.000Z" }),
        syncRow({ fieldKey: "model", lastResult: "ok", lastAttemptedAt: "2026-08-30T10:00:00.001Z" }),
      ],
      [],
    );

    expect(state.state).toBe("synced");
    expect(state).toMatchObject({
      omieId: "omie-77",
      lastAttemptedAt: "2026-08-30T10:00:00.001Z",
      mappingConfirmed: false,
    });
  });

  it("reports the failure with its field and the recorded reason", () => {
    const state = buildVehicleOmieSync(
      vehicle,
      [
        syncRow({ fieldKey: "plate", lastResult: "ok", lastAttemptedAt: "2026-08-01T10:00:00.000Z" }),
        syncRow({
          fieldKey: "odometerKm",
          lastResult: "failed",
          lastError: "wire_mapping_failed",
          lastAttemptedAt: "2026-08-29T10:00:00.000Z",
        }),
      ],
      [],
    );

    expect(vehicleOmieSyncSchema.parse(state)).toEqual({
      vehicleId: "veh-1",
      mappingConfirmed: false,
      state: "failed",
      omieId: "omie-77",
      lastAttemptedAt: "2026-08-29T10:00:00.000Z",
      fieldKey: "odometerKm",
      reason: "wire_mapping_failed",
    });
  });

  it("reports a failure that recorded no reason as a null reason", () => {
    const state = buildVehicleOmieSync(
      vehicle,
      [syncRow({ fieldKey: "plate", lastResult: "failed", lastAttemptedAt: "2026-08-29T10:00:00.000Z" })],
      [],
    );

    expect(state).toMatchObject({ state: "failed", reason: null });
  });

  it("ranks an open conflict above a failed attempt", () => {
    const state = buildVehicleOmieSync(
      vehicle,
      [
        syncRow({
          fieldKey: "plate",
          lastResult: "failed",
          lastError: "wire_mapping_failed",
          lastAttemptedAt: "2026-08-29T10:00:00.000Z",
        }),
      ],
      [{ fieldKey: "plate", crmValue: "ABC1D23", omieValue: "ABC-1234" }],
    );

    expect(state.state).toBe("conflict");
  });

  it("ranks a failed attempt above being linked to the Omie", () => {
    const state = buildVehicleOmieSync(
      vehicle,
      [
        syncRow({ fieldKey: "make", lastResult: "ok", lastAttemptedAt: "2026-08-01T10:00:00.000Z" }),
        syncRow({
          fieldKey: "plate",
          lastResult: "failed",
          lastError: "omie_timeout",
          lastAttemptedAt: "2026-08-29T10:00:00.000Z",
        }),
      ],
      [],
    );

    expect(state.state).toBe("failed");
  });

  it("reports a conflict on a vehicle that has no Omie id", () => {
    const state = buildVehicleOmieSync(unlinked, [], [
      { fieldKey: "plate", crmValue: "ABC1D23", omieValue: "ABC-1234" },
    ]);

    expect(state).toMatchObject({ state: "conflict", omieId: null, lastAttemptedAt: null });
  });

  it("returns every conflicting field with both values", () => {
    const state = buildVehicleOmieSync(
      vehicle,
      [syncRow({ fieldKey: "plate", lastResult: "ok", lastAttemptedAt: "2026-08-01T10:00:00.000Z" })],
      [
        { fieldKey: "plate", crmValue: "ABC1D23", omieValue: "ABC-1234" },
        { fieldKey: "model", crmValue: "Onix", omieValue: "ONIX LT" },
      ],
    );

    const parsed = vehicleOmieSyncSchema.parse(state);
    expect(parsed.state === "conflict" && parsed.fields).toEqual([
      { fieldKey: "plate", crmValue: "ABC1D23", omieValue: "ABC-1234" },
      { fieldKey: "model", crmValue: "Onix", omieValue: "ONIX LT" },
    ]);
  });

  it("names the later of two failures when the later one comes second", () => {
    const state = buildVehicleOmieSync(
      vehicle,
      [
        syncRow({
          fieldKey: "plate",
          lastResult: "failed",
          lastError: "primeiro",
          lastAttemptedAt: "2026-08-01T10:00:00.000Z",
        }),
        syncRow({
          fieldKey: "model",
          lastResult: "failed",
          lastError: "segundo",
          lastAttemptedAt: "2026-08-29T10:00:00.000Z",
        }),
      ],
      [],
    );

    expect(state).toMatchObject({ state: "failed", fieldKey: "model", reason: "segundo" });
  });

  it("names the later of two failures when the later one comes first", () => {
    const state = buildVehicleOmieSync(
      vehicle,
      [
        syncRow({
          fieldKey: "model",
          lastResult: "failed",
          lastError: "segundo",
          lastAttemptedAt: "2026-08-29T10:00:00.000Z",
        }),
        syncRow({
          fieldKey: "plate",
          lastResult: "failed",
          lastError: "primeiro",
          lastAttemptedAt: "2026-08-01T10:00:00.000Z",
        }),
      ],
      [],
    );

    expect(state).toMatchObject({ state: "failed", fieldKey: "model", reason: "segundo" });
  });

  it("prefers a dated failure over an undated one, whichever order they arrive in", () => {
    const undatedFirst = buildVehicleOmieSync(
      vehicle,
      [
        syncRow({ fieldKey: "plate", lastResult: "failed", lastError: "sem data" }),
        syncRow({
          fieldKey: "model",
          lastResult: "failed",
          lastError: "com data",
          lastAttemptedAt: "2026-08-29T10:00:00.000Z",
        }),
      ],
      [],
    );
    const datedFirst = buildVehicleOmieSync(
      vehicle,
      [
        syncRow({
          fieldKey: "model",
          lastResult: "failed",
          lastError: "com data",
          lastAttemptedAt: "2026-08-29T10:00:00.000Z",
        }),
        syncRow({ fieldKey: "plate", lastResult: "failed", lastError: "sem data" }),
      ],
      [],
    );

    expect(undatedFirst).toMatchObject({ fieldKey: "model", reason: "com data" });
    expect(datedFirst).toMatchObject({ fieldKey: "model", reason: "com data" });
  });

  it("falls back to the first failure when no attempt recorded a time", () => {
    const state = buildVehicleOmieSync(
      vehicle,
      [
        syncRow({ fieldKey: "plate", lastResult: "failed", lastError: "primeiro" }),
        syncRow({ fieldKey: "model", lastResult: "failed", lastError: "segundo" }),
      ],
      [],
    );

    expect(state).toMatchObject({
      state: "failed",
      fieldKey: "plate",
      reason: "primeiro",
      lastAttemptedAt: null,
    });
  });
});
