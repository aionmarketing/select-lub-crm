/**
 * Test design (testing-strategy)
 *
 * Setup: fetchConversationServices against MSW.
 *
 * Oracle: shared-types conversationServicesSchema;
 * complete-omie-integration customer-services HTTP — GET wrapper only.
 *
 * Axes
 *   A1 HTTP status: 2xx vs not (GET 500)
 *   A2 GET JSON: valid ConversationServices vs missing `services`
 *
 * Outputs: O1 parsed ConversationServices; O3 throw
 *
 * Sampled-cell
 *   it                                    | sampled axes      | expect | fails if
 *   parses a GET with a null customer     | A1 2xx, A2 valid  | O1     | throws
 *   rejects a GET body without services   | A2 missing key    | O3     | parses
 *   throws when the GET status is not ok  | A1 GET 500        | O3     | parses
 *
 * Decision map (api/services.ts + api/http.ts parse)
 *   D1 parse(): if (!response.ok) throw
 *      T: GET 500
 *      F: GET 200
 *   D2 fetchConversationServices → conversationServicesSchema.parse
 *      T: GET with null customer
 *      F: GET body without `services`
 *
 * Out of scope: ContactRail (ConversasPage.services.test); Fastify inject;
 * removed patchService client (no mutate route).
 */
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { fetchConversationServices } from "./api.js";
import { server } from "../test/msw/server.js";

const emptyList = { customerId: null, services: [] };

afterEach(() => {
  server.resetHandlers();
});

describe("fetchConversationServices", () => {
  it("parses a GET with a null customer", async () => {
    server.use(http.get("*/api/conversations/:id/services", () => HttpResponse.json(emptyList)));

    const result = await fetchConversationServices("conv-1");

    expect(result).toEqual(emptyList);
  });

  it("rejects a GET body without services", async () => {
    server.use(
      http.get("*/api/conversations/:id/services", () => HttpResponse.json({ customerId: null })),
    );

    await expect(fetchConversationServices("conv-1")).rejects.toThrow();
  });

  it("throws when the GET status is not ok", async () => {
    server.use(
      http.get("*/api/conversations/:id/services", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    await expect(fetchConversationServices("conv-1")).rejects.toThrow(/http 500/);
  });
});
