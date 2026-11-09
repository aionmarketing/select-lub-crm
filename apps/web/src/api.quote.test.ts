/**
 * Test design (testing-strategy)
 *
 * Setup: oil-quote / services API wrappers against MSW.
 *
 * Oracle: shared-types quoteOptionsResultSchema, oilQuoteSchema,
 * serviceListSchema, unitServiceListSchema — GET quote-options, POST quotes,
 * GET vehicle services, GET unit services. An `options` body without the Tecfil
 * `filters` block no longer parses, so the shared fixture supplies it.
 *
 * Axes
 *   A1 HTTP status: 2xx vs not
 *   A2 wrapper: options / create / vehicle list / unit list
 *
 * Outputs: O1 parsed body; O2 throw
 *
 * Sampled-cell
 *   options 200             | A1 2xx A2 options | O1 | throw
 *   options, no query       | D15               | URL has no query | a stale mode sent
 *   refetch POST            | D16               | POST, parsed union | a GET that forces a search
 *   create 201              | A1 2xx A2 create  | O1 | throw
 *   vehicle services 200    | A1 2xx A2 vehicle | O1 | throw
 *   unit services 200       | A1 2xx A2 unit    | O1 | throw
 *   options 500             | A1 500 A2 options | O2 | parses
 *
 * Decision map (api/quote.ts + api/http.ts parse)
 *   fetchQuoteOptions: no query string; requestOilRefetch: POST
 *   D1 !ok T: 500 it; F: 2xx its
 *
 * Out of scope: ConversasPage quote dialog; Fastify inject.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { REQUEST_TIMEOUT_MS } from "./api/http.js";
import { oilActionRefusalStatus, pickOilEngine, recordOilFillVolume } from "./api/quote.js";
import {
  catalogItemFixture,
  oilQuoteFixture,
  quoteOptionsWithFiltersFixture,
} from "@select-lub/shared-types";
import type { Service } from "@select-lub/shared-types";
import {
  createOilQuote,
  fetchQuoteOptions,
  fetchUnitServices,
  fetchVehicleServices,
  requestOilRefetch,
} from "./api.js";
import { server } from "../test/msw/server.js";

const serviceRow: Service = {
  id: "svc-1",
  customerId: "cus-1",
  vehicleId: "veh-1",
  omieId: null,
  unitId: "unit-1",
  performedAt: "2026-03-12T00:00:00.000Z",
  description: "Troca de óleo",
  kind: null,
  status: null,
  amount: 189.9,
  odometerKm: 42300,
  origin: "crm",
  items: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

// The shared fixture carries the Tecfil `filters` block the schema now requires, with one
// matched oil slot and a fuel slot that found no catalog item.
const optionsBody = quoteOptionsWithFiltersFixture;

afterEach(() => {
  server.resetHandlers();
});

describe("oil-quote and services API client", () => {
  it("parses quote-options", async () => {
    server.use(
      http.get("*/api/vehicles/:id/quote-options", () => HttpResponse.json(optionsBody)),
    );

    await expect(fetchQuoteOptions("veh-1")).resolves.toEqual(optionsBody);
  });

  // background-oil-research D15/D16: the read takes no mode; "Buscar novamente" is a POST.
  it("reads quote-options with no query string", async () => {
    let href = "";
    server.use(
      http.get("*/api/vehicles/:id/quote-options", ({ request }) => {
        href = request.url;
        return HttpResponse.json(optionsBody);
      }),
    );

    await fetchQuoteOptions("veh-1");

    expect(new URL(href).search).toBe("");
  });

  it("posts the refetch and parses its body as the quote-options union", async () => {
    const researching = {
      status: "researching",
      requestedAt: "2026-09-26T17:00:00.000Z",
      now: "2026-09-26T17:00:01.000Z",
      expectedMinutes: { min: 1, max: 3 },
      queuePosition: 0,
      path: "search",
      paused: null,
    };
    let method = "";
    server.use(
      http.post("*/api/vehicles/:id/oil-research/refetch", ({ request }) => {
        method = request.method;
        return HttpResponse.json(researching);
      }),
    );

    await expect(requestOilRefetch("veh-1")).resolves.toEqual(researching);
    expect(method).toBe("POST");
  });

  it("parses a created quote", async () => {
    server.use(
      http.post("*/api/vehicles/:id/quotes", () =>
        HttpResponse.json(oilQuoteFixture, { status: 201 }),
      ),
    );

    await expect(
      createOilQuote("veh-1", {
        generatedMessageText: oilQuoteFixture.generatedMessageText,
        lines: [{ catalogItemId: catalogItemFixture.id, price: 99.9 }],
      }),
    ).resolves.toEqual(oilQuoteFixture);
  });

  it("parses a vehicle service listing", async () => {
    server.use(
      http.get("*/api/vehicles/:id/services", () => HttpResponse.json([serviceRow])),
    );

    await expect(fetchVehicleServices("veh-1")).resolves.toEqual([serviceRow]);
  });

  it("parses the unit Serviços listing", async () => {
    const row = {
      ...serviceRow,
      customerName: "Ana",
      vehiclePlate: "ABC1D23",
      vehicleMake: "Toyota",
      vehicleModel: "Corolla",
      vehicleYear: 2019,
    };
    const page = { rows: [row], hasMore: false, nextCursor: null, totalCount: 1, totalAmount: 189.9 };
    server.use(http.get("*/api/services", () => HttpResponse.json(page)));

    await expect(fetchUnitServices()).resolves.toEqual(page);
  });

  it("throws when quote-options is not ok", async () => {
    server.use(
      http.get("*/api/vehicles/:id/quote-options", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    await expect(fetchQuoteOptions("veh-1")).rejects.toThrow(/http 500/);
  });
});

/**
 * Review of #198, finding 5: the dead-end POSTs (D24) share the reads' bound, so a POST nobody
 * answers rejects and the dialog says so instead of keeping its buttons disabled; and a refusal
 * keeps its status and body, which the dialog reads to tell a 409 from a 422.
 */
describe("the dead-end POSTs", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ["the engine pick", () => pickOilEngine("veh-1", "1.4 TSI")],
    ["the fill volume", () => recordOilFillVolume("veh-1", { liters: 4.2 })],
  ])("rejects %s the server never answers, after the shared bound", async (_name, send) => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    const pending = send();
    void pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 10);

    await expect(pending).rejects.toThrow(/timed out/i);
  });

  it("keeps a refusal's status and body", async () => {
    server.use(
      http.post("*/api/vehicles/:id/oil-research/engine-pick", () => HttpResponse.json({ reason: "version_changed" }, { status: 409 })),
    );

    const error = await pickOilEngine("veh-1", "1.4 TSI").catch((caught: unknown) => caught);

    expect(oilActionRefusalStatus(error)).toBe(409);
    expect((error as { body: unknown }).body).toEqual({ reason: "version_changed" });
  });
});
