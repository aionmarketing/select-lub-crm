/**
 * Test design (testing-strategy)
 *
 * Setup: call sortServices() with hand-built Service-shaped rows (only
 * `id` and `performedAt` matter to the comparator). No HTTP, no store.
 *
 * Moved from `apps/api/src/services/store.test.ts` (adopt-modular-vertical-slices
 * 3C) with `sortServices`, unchanged.
 *
 * Oracle: openspec/changes/customer-services-os/specs/customer-services/spec.md
 * "Customer-scoped service HTTP" — chronological, `performedAt` descending,
 * null dates last.
 *
 * Decision map (sortServices comparator, one `if`/`if`/`if` chain)
 *   both performedAt null      T → 0 (order unchanged)
 *   only a.performedAt null    T → a after b (1)
 *   only b.performedAt null    T → b after a (-1)
 *   neither null               F/F/F → localeCompare descending
 *
 * Sampled-cell
 *   two null-dated rows                | tie (both kept, order stable) | throws
 *   [null, dated] input                | dated first                   | null sorts first
 *   [dated, null] input                | dated first                   | null sorts first
 *   two dated rows, earlier first      | later first after sort        | earlier stays first
 *
 * Out of scope: the reads that call it (the slices' tests); Prisma ORDER BY.
 */
import { describe, expect, it } from "vitest";
import type { Service } from "../contracts/http.js";
import { sortServices } from "./service-dto.js";

function row(id: string, performedAt: string | null): Service {
  return {
    id,
    customerId: "cus-1",
    vehicleId: null,
    omieId: null,
    unitId: "unit-1",
    performedAt,
    description: null,
    kind: null,
    status: null,
    amount: null,
    odometerKm: null,
    origin: "crm",
    items: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("sortServices", () => {
  it("keeps two null-dated rows without throwing", () => {
    const sorted = sortServices([row("a", null), row("b", null)]);
    expect(sorted.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("puts a null-dated row after a dated row regardless of input order", () => {
    const nullFirst = sortServices([row("null", null), row("dated", "2026-01-01T00:00:00.000Z")]);
    const datedFirst = sortServices([row("dated", "2026-01-01T00:00:00.000Z"), row("null", null)]);
    expect(nullFirst.map((r) => r.id)).toEqual(["dated", "null"]);
    expect(datedFirst.map((r) => r.id)).toEqual(["dated", "null"]);
  });

  it("orders two dated rows with the later performedAt first", () => {
    const sorted = sortServices([
      row("earlier", "2026-01-01T00:00:00.000Z"),
      row("later", "2026-06-01T00:00:00.000Z"),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["later", "earlier"]);
  });
});
