/**
 * Test design (testing-strategy)
 *
 * Setup: fetchPrefill / acceptPrefillField / rejectPrefillField / retryPrefill
 * against MSW.
 *
 * Oracle: shared-types prefillSuggestionSchema + prefillAcceptBodySchema.
 *
 * Axes
 *   A1 HTTP status: 2xx vs not
 *   A2 GET JSON: pending plate vs missing status
 *   A3 POST accept: 200 vs 409
 *   A4 POST reject: 200 vs 500
 *
 * Outputs: O1 parsed suggestion; O2 throw
 *
 * Sampled-cell
 *   GET pending plate     | A1 2xx A2 valid | O1 | throws
 *   GET missing status    | A2 invalid      | O2 | parses
 *   GET 500               | A1 not ok       | O2 | parses
 *   POST accept 200       | A3 200          | O1 | throws
 *   POST accept 409       | A3 409          | O2 | parses
 *   POST reject 200       | A4 200          | O1 | throws
 *   POST reject 500       | A4 not ok       | O2 | parses
 *
 * Decision map (api/prefill.ts + api/http.ts parse)
 *   D1 parse() !ok throw   T: GET 500, POST 409, reject 500; F: 2xx
 *   D2 prefillSuggestionSchema.parse T: GET pending, POST 200, reject 200; F: missing status
 *
 * Out of scope: ContactRail (App.test); Fastify inject.
 */
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { acceptPrefillField, fetchPrefill, patchPrefillExtractEnabled, rejectPrefillField, retryPrefill } from "./api.js";
import { server } from "../test/msw/server.js";

afterEach(() => {
  server.resetHandlers();
});

describe("fetchPrefill", () => {
  it("parses a pending GET with only plate", async () => {
    server.use(
      http.get("*/api/conversations/:id/prefill", () =>
        HttpResponse.json({ status: "pending", fields: { plate: "ABC1D23" }, extractEnabled: false }),
      ),
    );

    const result = await fetchPrefill("conv-1");

    expect(result).toEqual({
      status: "pending",
      fields: { plate: "ABC1D23" },
      extractEnabled: false,
    });
  });

  it("rejects a GET body without status", async () => {
    server.use(http.get("*/api/conversations/:id/prefill", () => HttpResponse.json({ fields: {} })));

    await expect(fetchPrefill("conv-1")).rejects.toThrow();
  });

  it("throws when the GET status is not ok", async () => {
    server.use(
      http.get("*/api/conversations/:id/prefill", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    await expect(fetchPrefill("conv-1")).rejects.toThrow(/http 500/);
  });
});

describe("acceptPrefillField", () => {
  it("parses an accepted suggestion", async () => {
    server.use(
      http.post("*/api/conversations/:id/prefill/accept", () =>
        HttpResponse.json({ status: "empty", extractEnabled: false }),
      ),
    );

    const result = await acceptPrefillField("conv-1", { field: "plate", value: "ABC1D23" });

    expect(result).toEqual({ status: "empty", extractEnabled: false });
  });

  it("throws when POST is 409", async () => {
    server.use(
      http.post("*/api/conversations/:id/prefill/accept", () =>
        HttpResponse.json({}, { status: 409 }),
      ),
    );

    await expect(
      acceptPrefillField("conv-1", { field: "plate", value: "ABC1D23" }),
    ).rejects.toThrow(/http 409/);
  });
});

describe("retryPrefill", () => {
  it("parses extracting after retry", async () => {
    server.use(
      http.post("*/api/conversations/:id/prefill/retry", () =>
        HttpResponse.json({ status: "extracting", extractEnabled: false }),
      ),
    );

    const result = await retryPrefill("conv-1");

    expect(result.status).toBe("extracting");
  });
});

describe("patchPrefillExtractEnabled", () => {
  it("parses the suggestion after turning the switch on", async () => {
    server.use(
      http.patch("*/api/conversations/:id/prefill/extract-enabled", () =>
        HttpResponse.json({ status: "empty", extractEnabled: true }),
      ),
    );

    const result = await patchPrefillExtractEnabled("conv-1", true);

    expect(result).toEqual({ status: "empty", extractEnabled: true });
  });
});

describe("rejectPrefillField", () => {
  it("parses the suggestion after reject", async () => {
    server.use(
      http.post("*/api/conversations/:id/prefill/reject", () =>
        HttpResponse.json({ status: "empty", extractEnabled: false }),
      ),
    );

    const result = await rejectPrefillField("conv-1", "plate");

    expect(result).toEqual({ status: "empty", extractEnabled: false });
  });

  it("throws when POST is 500", async () => {
    server.use(
      http.post("*/api/conversations/:id/prefill/reject", () =>
        HttpResponse.json({ error: "fail" }, { status: 500 }),
      ),
    );

    await expect(rejectPrefillField("conv-1", "plate")).rejects.toThrow(/http 500/);
  });
});
