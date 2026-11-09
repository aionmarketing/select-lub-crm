/**
 * Test design (testing-strategy)
 *
 * Setup: fetchConversationVehicles / addConversationVehicle against MSW.
 *
 * Oracle: shared-types conversationVehiclesSchema + vehicleSchema;
 * conversas delta — GET wrapper, POST create.
 *
 * Axes (what we vary; a row only names the axes it actually touches)
 *   A1 HTTP status: 2xx vs not (GET 500 / POST 409)
 *   A2 GET JSON: valid ConversationVehicles vs missing `vehicles`
 *   A3 POST result: 201 + Vehicle body vs 409
 *
 * Outputs: O1 parsed ConversationVehicles; O2 parsed Vehicle; O3 throw
 *
 * Sampled-cell table
 *   A "cell" is one combination of axis classes. The full A1×A2×A3 grid
 *   is not run — each `it` samples one cell. expect = that cell's oracle.
 *   fails if = the observation that would let this cell's defect hide
 *   (the test staying green while the sampled class is broken).
 *
 *   it                                    | sampled axes      | expect | fails if
 *   parses a GET with a null customer     | A1 2xx, A2 valid  | O1     | throws
 *   rejects a GET body without vehicles   | A2 missing key    | O3     | parses
 *   throws when the GET status is not ok  | A1 GET 500        | O3     | parses
 *   parses a created vehicle              | A3 POST 201       | O2     | throws
 *   throws when POST is 409               | A3 POST 409       | O3     | parses
 *   PATCH customer 503                    | cadastro 503      | omieUnavailable | throw
 *   PATCH customer 200                    | cadastro 2xx      | omieUnavailable false | throw
 *   lookupPlate found                     | plate POST 200    | O2 found | throw
 *   lookupPlate 422                       | plate POST 422    | invalid_plate | parses
 *   lookupPlate retry                     | retry true        | body.retry | omitted
 *
 * Decision map (api/vehicles.ts + api/http.ts parse)
 *   fetchConversationVehicles (GET) and addConversationVehicle (POST)
 *   both call parse() first, then their own schema.parse on the JSON.
 *   Each line is one branch. T/F = which `it` takes that outcome.
 *
 *   D1 parse(): if (!response.ok) throw
 *      T (throw, body never parsed): GET 500, POST 409
 *      F (read JSON, then schema.parse): GET 200, POST 201
 *
 *   D2 fetchConversationVehicles → conversationVehiclesSchema.parse
 *      T (returns ConversationVehicles): GET with null customer
 *      F (zod throws): GET body without `vehicles`
 *      not reached on GET 500 (D1 T)
 *
 *   D3 addConversationVehicle → vehicleSchema.parse
 *      T (returns Vehicle): POST 201
 *      F not sampled: POST 409 never reaches parse (D1 T). A 2xx body
 *        that fails vehicleSchema is out of scope (same as Fastify inject).
 *
 *   parseCadastroWrite / patchVehicle 503 T: 503 it; F: 200 it
 *   parseCadastroWrite !ok T: POST 409 (add vehicle uses parse, not this helper);
 *     patchCustomer 4xx would throw — ConversasPage.cadastro.test 503 UI
 *
 * Out of scope: ContactRail (App.test Axis 5); Fastify inject;
 * POST 2xx with a body that fails vehicleSchema.
 */
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { customerFixture } from "@select-lub/shared-types";
import { addConversationVehicle, fetchConversationVehicles, lookupPlate, patchCustomer, patchVehicle } from "./api.js";
import { server } from "../test/msw/server.js";

const emptyList = { customerId: null, vehicles: [] };

const created = {
  id: "veh-api-1",
  customerId: "cus-api",
  omieId: null,
  plate: "XYZ9A87",
  make: null,
  model: null,
  version: null,
  year: null,
  odometerKm: null,
  origin: "crm",
  plateSourcedKeys: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

afterEach(() => {
  server.resetHandlers();
});

describe("fetchConversationVehicles", () => {
  it("parses a GET with a null customer", async () => {
    server.use(http.get("*/api/conversations/:id/vehicles", () => HttpResponse.json(emptyList)));

    const result = await fetchConversationVehicles("conv-1");

    expect(result).toEqual(emptyList);
  });

  it("rejects a GET body without vehicles", async () => {
    server.use(
      http.get("*/api/conversations/:id/vehicles", () => HttpResponse.json({ customerId: null })),
    );

    await expect(fetchConversationVehicles("conv-1")).rejects.toThrow();
  });

  it("throws when the GET status is not ok", async () => {
    server.use(
      http.get("*/api/conversations/:id/vehicles", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    await expect(fetchConversationVehicles("conv-1")).rejects.toThrow(/http 500/);
  });
});

describe("addConversationVehicle", () => {
  it("parses a created vehicle", async () => {
    server.use(
      http.post("*/api/conversations/:id/vehicles", () =>
        HttpResponse.json(created, { status: 201 }),
      ),
    );

    const result = await addConversationVehicle("conv-1", { plate: "XYZ9A87" });

    expect(result).toEqual(created);
  });

  it("throws when POST is 409", async () => {
    server.use(
      http.post("*/api/conversations/:id/vehicles", () =>
        HttpResponse.json({ error: "unresolved" }, { status: 409 }),
      ),
    );

    await expect(addConversationVehicle("conv-1")).rejects.toThrow(/http 409/);
  });

  it("flags omieUnavailable when PATCH customer returns 503 with a customer body", async () => {
    server.use(
      http.patch("*/api/customers/:id", () =>
        HttpResponse.json(customerFixture, { status: 503 }),
      ),
    );

    await expect(patchCustomer("cus-1", { name: "Maria Silva" })).resolves.toEqual({
      customer: customerFixture,
      omieUnavailable: true,
    });
  });

  it("flags omieUnavailable false when PATCH customer returns 200", async () => {
    server.use(
      http.patch("*/api/customers/:id", () => HttpResponse.json(customerFixture)),
    );

    await expect(patchCustomer("cus-1", { name: "Maria Silva" })).resolves.toEqual({
      customer: customerFixture,
      omieUnavailable: false,
    });
  });

  it("flags omieUnavailable when PATCH vehicle returns 503", async () => {
    server.use(
      http.patch("*/api/vehicles/:id", () => HttpResponse.json(created, { status: 503 })),
    );

    await expect(patchVehicle("veh-api-1", { plate: "XYZ9A87" })).resolves.toEqual({
      vehicle: created,
      omieUnavailable: true,
    });
  });
});

describe("lookupPlate", () => {
  it("parses a found lookup", async () => {
    const body = {
      status: "found",
      source: "mock",
      provider: "mock",
      cached: false,
      fields: { make: "VW" },
    };
    server.use(http.post("*/api/plate-lookups", () => HttpResponse.json(body)));

    await expect(lookupPlate("ABC1D23")).resolves.toEqual(body);
  });

  it("throws invalid_plate on HTTP 422", async () => {
    server.use(
      http.post("*/api/plate-lookups", () =>
        HttpResponse.json({ code: "invalid_plate" }, { status: 422 }),
      ),
    );

    await expect(lookupPlate("ZZZZZZZ")).rejects.toThrow("invalid_plate");
  });

  it("sends retry: true when retrying a miss", async () => {
    const payloads: unknown[] = [];
    server.use(
      http.post("*/api/plate-lookups", async ({ request }) => {
        payloads.push(await request.json());
        return HttpResponse.json({ status: "unavailable" });
      }),
    );

    await lookupPlate("ABC1D23", { retry: true });

    expect(payloads).toEqual([{ plate: "ABC1D23", retry: true }]);
  });
});
