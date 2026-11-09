/**
 * Test design (testing-strategy)
 *
 * Moved from `apps/api/src/http/cadastro-link.test.ts` (adopt-modular-vertical-
 * slices 4B); runs under module_customers. This file keeps that suite's
 * `vehicleFromCreate` case, called through the re-export on this slice's
 * `index.ts`, assertions unchanged. The suite's `resolveCadastroCustomer` and
 * `refreshLinkedCustomer` cases, and its full design, are in
 * get-conversation-customer/tests/get-conversation-customer.link.integration.test.ts.
 *
 * SUT: `vehicleFromCreate` — the row a create request writes.
 *
 * Setup: none. It is a pure function over its argument and touches no store;
 *   it stays inside `describeWithDatabase` only because the suite it came from
 *   did, so it runs and skips with its neighbours.
 *
 * No fake-only assertion surfaced for `vehicleFromCreate`: it is a pure
 *   function over its argument and touches no store, so it is unchanged.
 *
 * Oracle: cadastro / conversas — vehicle create from CRM persists omitted
 *   fields as null.
 *
 * Axes
 *   A4 create body — plate set / omitted
 *
 * Outputs
 *   O4 vehicle origin crm; plate or null
 *
 * Sampled-cell
 *   plate omitted        | A4 omit        | O4 | leftover plate
 *   plate set            | A4 set         | O4 | null plate
 *
 * vehicleFromCreate has only `??` (named, not extra ifs).
 */
import { expect, it } from "vitest";
import { describeWithDatabase } from "../../../../testing/index.js";
import { vehicleFromCreate } from "../index.js";

describeWithDatabase("cadastro-link helpers (real adapters)", () => {
  it("creates a CRM-origin vehicle with omitted fields stored as null", () => {
    // Pure function over its argument: no store, no transaction.
    const empty = vehicleFromCreate("cust-1", {});
    expect(empty.customerId).toBe("cust-1");
    expect(empty.origin).toBe("crm");
    expect(empty.plate).toBeNull();
    expect(empty.omieId).toBeNull();

    const plated = vehicleFromCreate("cust-1", { plate: "ABC1D23" });
    expect(plated.plate).toBe("ABC1D23");
  });
});
