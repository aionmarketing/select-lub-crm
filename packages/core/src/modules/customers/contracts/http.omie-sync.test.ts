/**
 * Test design (testing-strategy)
 *
 * Setup: zod safeParse/parse on PATCH body and GET pending row. No HTTP, no DB.
 *
 * Oracle: openspec/changes/omie-field-conflict-sync/proposal.md (Capabilities)
 * and design.md D5 (closed field keys) + D7/D8 (PATCH partial + pending row).
 *
 * Techniques: EP (one invalid class per `it`), BVA on trim().min(1) for `name`
 * when that key is present, branch coverage of optional-key vs present-empty.
 *
 * ----------------------------------------------------------------------------
 * Axes
 * ----------------------------------------------------------------------------
 * A1 PATCH presence — which keys are in the body
 *   EP valid: only CRM-only `givenName`; any subset of shared keys with valid values
 *   EP invalid: `name` present and empty / whitespace (own `it`s)
 *   Sampled: only `givenName`; `name: ""`
 *   Not sampled: every other optional-key combo; whitespace `name` (same trim
 *   partition as remainder Customer.name — one empty-present sample here)
 *
 * A2 pending status
 *   EP valid: `open` (only status this change stores)
 *   EP invalid: any other status string (own `it`)
 *   Sampled: `open`; `"resolved"` as one invalid class
 *
 * A3 pending fieldKey catalog
 *   EP valid: D5 closed list (sampled `name` with vehicleId null)
 *   EP invalid: unknown key (not sampled — same enum-reject as Template vars
 *   in remainder.test.ts; fieldKey is not a new decision shape)
 *
 * A4 resolve choice — crm without value (valid) vs edit without value (invalid)
 * A5 conversation GET — customer null + empty pendings
 * A6 global pending — customerId + customerName present
 * A7 ConversationSummary — must not grow customer/pendings keys
 *
 * Outputs: O1 parse success; O2 safeParse.success === false
 *
 * ----------------------------------------------------------------------------
 * Sampled-cell table
 * ----------------------------------------------------------------------------
 * it                                         | axes     | O | fails if
 * parses PATCH body with only givenName      | A1 valid | 1 | parse throws
 * rejects PATCH when name is present and ""  | A1 empty | 2 | success
 * parses open pending row                    | A2 valid | 1 | parse throws
 * rejects pending with status resolved       | A2 inv.  | 2 | success
 * parses crm choice without value            | A4 crm   | 1 | parse throws
 * rejects edit choice without value          | A4 edit  | 2 | success
 * parses conversation GET with null customer | A5 null  | 1 | parse throws
 * parses global pending with customer name   | A6 valid | 1 | parse throws
 * ConversationSummary has no cadastro keys   | A7       | 1 | key present
 *
 * ----------------------------------------------------------------------------
 * Decision / branch map
 * ----------------------------------------------------------------------------
 * name optional missing — only-givenName `it` (false of "name present")
 * name present + trim min(1) false — empty name `it`
 * status === "open" true — open pending `it`; false — resolved `it`
 * choice discriminant crm/edit — crm-without-value vs edit-without-value
 *
 * Out of scope: engine maps; HTTP 404/409; every shared key on PATCH;
 * Prisma pending tables; resolve-pending status values beyond one invalid.
 */
import { describe, expect, it } from "vitest";
import { conversationCustomerSchema, customerFieldEditSchema, globalReconciliationPendingSchema, pendingResolveBodySchema, reconciliationPendingSchema } from "./http.omie-sync.js";
import { conversationSummarySchema } from "../../conversations/contracts/http.js";

describe("customerFieldEditSchema", () => {
  it("parses a PATCH body with only givenName", () => {
    const parsed = customerFieldEditSchema.parse({ givenName: "Maria" });
    expect(parsed.givenName).toBe("Maria");
  });

  it("rejects a PATCH body when name is present and empty", () => {
    expect(customerFieldEditSchema.safeParse({ name: "" }).success).toBe(false);
  });
});

describe("reconciliationPendingSchema", () => {
  it("parses an open pending row", () => {
    const parsed = reconciliationPendingSchema.parse({
      fieldKey: "name",
      crmValue: "Ana",
      omieValue: "ANA LTDA",
      status: "open",
      customerId: "cus-1",
      vehicleId: null,
    });
    expect(parsed.status).toBe("open");
  });

  it("rejects a pending row with status resolved", () => {
    expect(
      reconciliationPendingSchema.safeParse({
        fieldKey: "name",
        crmValue: "Ana",
        omieValue: "ANA LTDA",
        status: "resolved",
        customerId: "cus-1",
        vehicleId: null,
      }).success,
    ).toBe(false);
  });
});

describe("pendingResolveBodySchema", () => {
  it("parses a crm choice without value", () => {
    const parsed = pendingResolveBodySchema.parse({
      fieldKey: "postalCode",
      vehicleId: null,
      choice: "crm",
    });
    expect(parsed.choice).toBe("crm");
  });

  it("rejects an edit choice without value", () => {
    expect(
      pendingResolveBodySchema.safeParse({
        fieldKey: "name",
        vehicleId: null,
        choice: "edit",
      }).success,
    ).toBe(false);
  });
});

describe("conversationCustomerSchema", () => {
  it("parses a GET payload with a null customer", () => {
    const parsed = conversationCustomerSchema.parse({ customer: null, pendings: [] });
    expect(parsed.customer).toBeNull();
    expect(parsed.pendings).toEqual([]);
  });
});

describe("globalReconciliationPendingSchema", () => {
  it("parses a global pending row with customer identity", () => {
    const parsed = globalReconciliationPendingSchema.parse({
      fieldKey: "postalCode",
      crmValue: "22041080",
      omieValue: "22041000",
      status: "open",
      customerId: "cus_1",
      customerName: "Maria",
      vehicleId: null,
    });
    expect(parsed.customerId).toBe("cus_1");
    expect(parsed.customerName).toBe("Maria");
  });
});

describe("conversationSummarySchema cadastro keys", () => {
  it("does not gain customer or pendings keys", () => {
    expect("customer" in conversationSummarySchema.shape).toBe(false);
    expect("pendings" in conversationSummarySchema.shape).toBe(false);
  });
});
