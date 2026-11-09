/**
 * Test design (testing-strategy)
 *
 * Setup: plain object literals shaped as CustomerRecord/VehicleRecord/PendingRow
 * (store.ts) fed directly to the three mapping functions. No store, no fake
 * Omie — these are pure field-copy transforms with no branch of their own
 * except pendingToDto's forced `status`.
 *
 * Oracle: dto.ts's own JSDoc, cross-checked against the public `Customer` /
 * `Vehicle` / `ReconciliationPending` shapes in @select-lub/shared-types that
 * every field name here must match verbatim, since this is the package's own
 * boundary to those HTTP-facing contracts.
 *
 * Axes
 *   A1 customerToDto — mergedIntoId present; phones/emails non-empty
 *   A2 vehicleToDto — plateSourcedKeys omitted (default []) vs supplied
 *   A3 pendingToDto — row.status "open" (the only value CadastroStore ever
 *      hands this function; PendingRow's type also allows "resolved")
 *
 * Outputs
 *   O1 customer DTO: mergedInto mirrors mergedIntoId; phones/emails copied
 *   O2 vehicle DTO: plateSourcedKeys defaults to [], and is copied (not
 *      aliased) when supplied
 *   O3 pending DTO: status is always the literal "open"
 *
 * Sampled-cell
 *   customerToDto full row      | A1        | O1 | mergedInto undefined, or a
 *                                              phone/email dropped
 *   vehicleToDto no keys arg    | A2 default| O2 | plateSourcedKeys undefined
 *   vehicleToDto with keys      | A2 supplied| O2 | the same array reference
 *                                              (mutating the input would leak)
 *   pendingToDto forces "open"  | A3        | O3 | status echoes a "resolved"
 *                                              row's own status
 *
 * Decision / branch map: none in customerToDto or vehicleToDto (pure field
 *   copies, one `.map()` with no conditional inside); pendingToDto has one
 *   decision-free literal (`status: "open"`), asserted directly against a
 *   row whose OWN status is "resolved" to prove it is a constant, not an
 *   echo.
 *
 * Out of scope: none — every exported function of this file is covered.
 */
import { describe, expect, it } from "vitest";
import { customerToDto, pendingToDto, vehicleToDto } from "./cadastro-dto.js";
import type { CustomerRecord, PendingRow, VehicleRecord } from "./cadastro-store/port.js";

const customerRow: CustomerRecord = {
  id: "cus-1",
  name: "Ana",
  omieId: "omie-1",
  taxId: "39053344705",
  unitId: "unit-1",
  givenName: "Ana",
  familyName: "Silva",
  mergedIntoId: "cus-base",
  street: "Rua A",
  streetNumber: "10",
  neighborhood: "Centro",
  complement: "ap 1",
  city: "Sao Paulo",
  state: "SP",
  postalCode: "01310100",
  country: "br",
  origin: "OMIE",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  phones: [{ raw: "+55 11 99999-0000", normalized: "5511999990000", isPrimary: true }],
  emails: [{ raw: "ana@example.com", normalized: "ana@example.com", isPrimary: true }],
};

const vehicleRow: VehicleRecord = {
  id: "veh-1",
  customerId: "cus-1",
  omieId: null,
  plate: "ABC1D23",
  make: "VW",
  model: "Gol",
  version: "1.0",
  year: 2020,
  odometerKm: 12000,
  origin: "OMIE",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("customerToDto", () => {
  it("mirrors mergedIntoId as mergedInto and copies contacts verbatim", () => {
    const dto = customerToDto(customerRow);

    expect(dto.mergedInto).toBe("cus-base");
    expect(dto.phones).toEqual([
      { raw: "+55 11 99999-0000", normalized: "5511999990000", isPrimary: true },
    ]);
    expect(dto.emails).toEqual(customerRow.emails);
    expect(dto.id).toBe("cus-1");
    expect(dto.postalCode).toBe("01310100");
  });
});

describe("vehicleToDto", () => {
  it("defaults plateSourcedKeys to an empty array when omitted", () => {
    const dto = vehicleToDto(vehicleRow);

    expect(dto.plateSourcedKeys).toEqual([]);
    expect(dto.plate).toBe("ABC1D23");
    expect(dto.customerId).toBe("cus-1");
  });

  it("copies the supplied plateSourcedKeys rather than aliasing the input array", () => {
    const keys = ["make"] as const;

    const dto = vehicleToDto(vehicleRow, keys);

    expect(dto.plateSourcedKeys).toEqual(["make"]);
    // A copy, not the same reference: mutating the DTO's array must not
    // reach back into the caller's own list.
    expect(dto.plateSourcedKeys).not.toBe(keys);
  });
});

describe("pendingToDto", () => {
  it("forces status open even when the stored row's own status is resolved", () => {
    // Proves `status: "open"` is a literal the function always writes, not an
    // echo of `row.status` — the type of PendingRow allows "resolved", and a
    // caller who reused this function on a wrong row would otherwise get a
    // silently incorrect DTO.
    const resolvedRow: PendingRow = {
      fieldKey: "postalCode",
      crmValue: "CRMCEP12",
      omieValue: "OMIECEP1",
      localVersion: 2,
      externalVersion: 2,
      status: "resolved",
      customerId: "cus-1",
      vehicleId: null,
      resolvedByUserId: "user-1",
    };

    const dto = pendingToDto(resolvedRow);

    expect(dto.status).toBe("open");
    expect(dto.fieldKey).toBe("postalCode");
    expect(dto.crmValue).toBe("CRMCEP12");
    expect(dto.omieValue).toBe("OMIECEP1");
    expect(dto.vehicleId).toBeNull();
  });
});
