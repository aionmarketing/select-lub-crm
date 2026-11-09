/**
 * Test design (testing-strategy)
 *
 * Setup: zod parse / safeParse. No HTTP.
 *
 * Oracle: openspec/changes/complete-omie-integration/specs/customer-services/spec.md
 * (Serviço contract, ItemDeServiço contract, conversation list contracts).
 * Write bodies are gone — Omie import/seed is the only creator.
 *
 * Axis 1 — Serviço full record (EP)
 *   EP valid: only customerId/unitId/origin/items set, every other optional
 *     field null, items: [] ("service with only customerId and nulls")
 *   ConversationSummary stays without a services array (index.test P2 style)
 *
 * Axis 2 — ItemDeServiço full record (EP)
 *   EP valid: non-empty description, oil fields null ("item without oil")
 *   EP invalid: empty description (own `it`, trim().min(1) boundary)
 *
 * Axis 3 — conversation GET wrapper (EP)
 *   EP valid: null customerId with empty services array
 *
 * Axis 4 — barrel has no write schemas (EP)
 *   serviceCreateBodySchema / servicePatchBodySchema absent from the package export
 *
 * Axis 5 — unit Serviços query (EP + boundary)
 *   Oracle: build-servicos-list-detail shared-types delta, "Service read contracts".
 *   EP valid: {} — no date bound, no search, first page
 *   EP valid: limit arrives as a query string and coerces to a number
 *   EP invalid: from after to (superRefine boundary)
 *
 * Axis 6 — unit Serviços page envelope (EP)
 *   EP valid: rows + hasMore + nextCursor
 *   EP invalid: a bare array of rows (the pre-change response shape)
 *   EP invalid: hasMore true with a null nextCursor (invariant boundary)
 *
 * Axis 7 — service detail (EP)
 *   EP valid: row + items + attributed quote + vehicle history
 *   EP valid: empty items, null attributedQuote, empty history
 *   EP valid: odometerKm null — absent, distinct from a reading of 0
 *
 * Outputs: O1 parse success (throws on `.parse`); O2 safeParse fails
 *
 * Sampled-cell
 *   Serviço with empty items + nulls              | O1 | throws
 *   ItemDeServiço without oil fields               | O1 | throws
 *   ItemDeServiço empty description                | O2 | success
 *   conversation GET null customer                   | O1 | throws
 *   ConversationSummary has no services key           | —  | key present
 *   barrel omits write bodies                         | —  | key present
 *   query {} -> unbounded first page                  | O1 | throws
 *   query from > to                                   | O2 | success
 *   page envelope with continuation                   | O1 | throws
 *   bare array as page                                | O2 | success
 *   hasMore true, nextCursor null                     | O2 | success
 *   detail with items, quote, history                 | O1 | throws
 *   detail with null odometerKm                       | O1 | throws
 *
 * Out of scope: HTTP routes/persistence; Prisma Decimal→number conversion.
 */
import { describe, expect, it } from "vitest";
import { conversationServicesSchema, serviceDetailSchema, serviceItemSchema, serviceSchema, unitServicePageSchema, unitServiceQuerySchema } from "./http.service.js";
import { conversationSummarySchema } from "../../conversations/contracts/http.js";
import * as barrel from "./index.js";

describe("Serviço contract", () => {
  it("parses a service with only customerId set and nulls elsewhere", () => {
    const parsed = serviceSchema.parse({
      id: "svc-1",
      customerId: "cus-1",
      vehicleId: null,
      omieId: "os-1",
      unitId: "unit-1",
      performedAt: null,
      description: null,
      kind: null,
      status: null,
      amount: null,
      odometerKm: null,
      origin: "omie",
      items: [],
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    });
    expect(parsed.items).toEqual([]);
    expect(parsed.vehicleId).toBeNull();
    expect(parsed.origin).toBe("omie");
  });
});

describe("ItemDeServiço contract", () => {
  it("parses an item without oil fields", () => {
    const parsed = serviceItemSchema.parse({
      id: "item-1",
      serviceId: "svc-1",
      description: "Troca de óleo",
      kind: null,
      quantity: null,
      unitAmount: null,
      lineAmount: null,
      oilViscosity: null,
      oilBrand: null,
    });
    expect(parsed.oilViscosity).toBeNull();
    expect(parsed.oilBrand).toBeNull();
  });

  it("rejects an empty item description", () => {
    expect(
      serviceItemSchema.safeParse({
        id: "item-1",
        serviceId: "svc-1",
        description: "",
        kind: null,
        quantity: null,
        unitAmount: null,
        lineAmount: null,
        oilViscosity: null,
        oilBrand: null,
      }).success,
    ).toBe(false);
  });
});

describe("service write payloads are not exported", () => {
  it("omits create and patch body schemas from the barrel", () => {
    expect("serviceCreateBodySchema" in barrel).toBe(false);
    expect("servicePatchBodySchema" in barrel).toBe(false);
    expect("ServiceCreateBody" in barrel).toBe(false);
    expect("ServicePatchBody" in barrel).toBe(false);
  });
});

describe("conversation-services GET wrapper", () => {
  it("parses a conversation-services GET with a null customer", () => {
    expect(conversationServicesSchema.parse({ customerId: null, services: [] })).toEqual({
      customerId: null,
      services: [],
    });
  });
});

describe("conversation list item stays without a services key", () => {
  it("parses an inbox list item without a services array", () => {
    const parsed = conversationSummarySchema.parse({
      id: "conv-1",
      contactLabel: "11999999999",
      phone: "11999999999",
      lastSnippet: "oi",
      lastMessageAt: "2026-08-26T12:00:00.000Z",
      tags: [],
      sourceType: "UNKNOWN",
      unanswered: false,
      pipelineStage: "novosContatos",
    });
    expect("services" in parsed).toBe(false);
  });
});

/** Minimal unit Serviços row: every optional field null, no items. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "svc-1",
    customerId: "cus-1",
    vehicleId: "veh-1",
    omieId: "os-10482",
    unitId: "unit-1",
    performedAt: "2026-03-12T00:00:00.000Z",
    description: "Troca de óleo",
    kind: "troca-de-oleo",
    status: "Concluído",
    amount: 189.9,
    odometerKm: 42300,
    origin: "omie",
    items: [],
    createdAt: "2026-03-12T00:00:00.000Z",
    updatedAt: "2026-03-12T00:00:00.000Z",
    customerName: "Roberto Aparecido",
    vehiclePlate: "ABC-1D23",
    vehicleMake: "Toyota",
    vehicleModel: "Corolla",
    vehicleYear: 2019,
    ...overrides,
  };
}

describe("unit Serviços query", () => {
  it("parses an empty query as no date bound, no search, and the first page", () => {
    const parsed = unitServiceQuerySchema.parse({});
    expect(parsed.from).toBeUndefined();
    expect(parsed.to).toBeUndefined();
    expect(parsed.search).toBeUndefined();
    expect(parsed.cursor).toBeUndefined();
  });

  it("coerces a limit arriving as a query string", () => {
    expect(unitServiceQuerySchema.parse({ limit: "50" }).limit).toBe(50);
  });

  it("rejects a from that falls after its to", () => {
    expect(
      unitServiceQuerySchema.safeParse({ from: "2026-03-12", to: "2026-03-01" }).success,
    ).toBe(false);
  });
});

describe("unit Serviços page envelope", () => {
  it("parses a page carrying rows, hasMore, and a continuation", () => {
    const parsed = unitServicePageSchema.parse({
      rows: [row()],
      hasMore: true,
      nextCursor: "2026-03-12T00:00:00.000Z|svc-1",
      totalCount: 31,
      totalAmount: 7412.3,
    });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.nextCursor).not.toBeNull();
    // Totals describe the whole match, so they outrun the page.
    expect(parsed.totalCount).toBe(31);
  });

  it("rejects a bare array of rows, the pre-change response shape", () => {
    expect(unitServicePageSchema.safeParse([row()]).success).toBe(false);
  });

  it("rejects hasMore true without a continuation", () => {
    expect(
      unitServicePageSchema.safeParse({
        rows: [row()],
        hasMore: true,
        nextCursor: null,
        totalCount: 1,
        totalAmount: 0,
      }).success,
    ).toBe(false);
  });
});

describe("service detail contract", () => {
  it("parses a detail with items, an attributed quote, and vehicle history", () => {
    const parsed = serviceDetailSchema.parse({
      ...row({
        items: [
          {
            id: "item-1",
            serviceId: "svc-1",
            description: "Motul 5100 5W-30",
            kind: null,
            quantity: 4,
            unitAmount: 34.9,
            lineAmount: 139.6,
            oilViscosity: "5W-30",
            oilBrand: "Motul",
          },
        ],
      }),
      attributedQuote: { quoteId: "q-1", sentAt: "2026-03-08T00:00:00.000Z", ruleVersion: 1 },
      vehicleHistory: [],
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.attributedQuote?.ruleVersion).toBe(1);
  });

  it("parses a detail with no items, no attributed quote, and no history", () => {
    const parsed = serviceDetailSchema.parse({
      ...row(),
      attributedQuote: null,
      vehicleHistory: [],
    });
    expect(parsed.attributedQuote).toBeNull();
    expect(parsed.vehicleHistory).toEqual([]);
  });

  it("keeps an absent odometer reading distinct from a reading of zero", () => {
    const absent = serviceDetailSchema.parse({
      ...row({ odometerKm: null }),
      attributedQuote: null,
      vehicleHistory: [],
    });
    const zero = serviceDetailSchema.parse({
      ...row({ odometerKm: 0 }),
      attributedQuote: null,
      vehicleHistory: [],
    });
    expect(absent.odometerKm).toBeNull();
    expect(zero.odometerKm).toBe(0);
  });
});
