/**
 * Test design (testing-strategy)
 *
 * Setup: createAgregadosPropriaAdapter with injected fetch. Fixtures from
 * the fixtures/ beside this file. No live HTTP.
 *
 * Spec: plate-lookup — mapping table (sintetico before modelo, ano_modelo not
 * ano_fabricacao); unknown fields omitted; exhausted balance ≠ miss.
 *
 * Axes
 * A1 envelope — success / live-found / no versao / no modeloDetalhes /
 *   placeholders / 404 miss / 422 / 402 / 403
 * A2 billed — homolog 200 (false) vs live 200 (true) vs 4xx (false)
 *
 * Outputs: O-found fields; O-not_found; O-failed reason
 *
 * Decision map (agregados-propria.ts lookup)
 * D1 !token              T: not_configured (empty-token it); F: fetch its
 * D2 timeout/error       T: timeout.test.ts; F: fixture its
 * D3 status 402          T: insufficient-balance it; F: other status
 * D4 status 403          T: pj-required it; F: other
 * D5 status 404          T: live-miss not_found it; F: other
 * D6 status !== 200      T: invalid-plate 422 it; F: 200 its
 * D7 foundOrNotFound     T: success/live/variants; F: 404 miss
 *
 * Out of scope: live APIBrasil (tasks 7.x).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createAgregadosPropriaAdapter, AGREGADOS_PROPRIA_URL } from "./agregados-propria.js";

function loadFixture(name: string): { http: number; json: unknown } {
  return JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "./fixtures", name), "utf8"),
  ) as { http: number; json: unknown };
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function adapterFor(fixture: { http: number; json: unknown }) {
  const fetchImpl = vi.fn(async () => jsonResponse(fixture.json, fixture.http));
  return {
    adapter: createAgregadosPropriaAdapter({ token: "test-token", fetch: fetchImpl }),
    fetchImpl,
  };
}

describe("createAgregadosPropriaAdapter", () => {
  it("maps the sandbox vehicle using sintetico and ano_modelo", async () => {
    const { adapter, fetchImpl } = adapterFor(loadFixture("agregados-propria-success.json"));

    const result = await adapter.lookup("ABC1234");

    expect(result).toMatchObject({
      status: "found",
      source: "provider",
      provider: "agregados-propria",
      billed: false,
      fields: {
        make: "VW",
        model: "GOL",
        version: "1.0 FLEX 12V 4P",
        year: 2021,
        displacementCc: 999,
        fuel: "ALCOOL/GASOLINA",
      },
    });
    expect(result.status === "found" && result.fields.year).toBe(2021);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      AGREGADOS_PROPRIA_URL,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ placa: "ABC1234", tipo: "agregados-propria" }),
      }),
    );
  });

  it("maps a live capture using modelo when sintetico is a boolean", async () => {
    const { adapter } = adapterFor(loadFixture("agregados-propria-live-found.json"));

    const result = await adapter.lookup("PZY7H82");

    expect(result).toMatchObject({
      status: "found",
      source: "provider",
      provider: "agregados-propria",
      billed: true,
      fields: {
        make: "HYUNDAI",
        model: "HB20",
        year: 2018,
        displacementCc: 998,
        fuel: "ALCOOL / GASOLINA",
      },
    });
    expect(result.status === "found" && result.fields.version).toBeUndefined();
    expect(result.status === "found" && result.fields.year).toBe(2018);
  });

  it("omits version when versao is absent", async () => {
    const { adapter } = adapterFor(loadFixture("agregados-propria-no-versao.json"));

    const result = await adapter.lookup("ABC1234");

    expect(result.status).toBe("found");
    expect(result.status === "found" && result.fields.version).toBeUndefined();
    expect(result.status === "found" && result.fields.model).toBe("GOL");
  });

  it("falls back to modelo when modeloDetalhes is absent", async () => {
    const { adapter } = adapterFor(loadFixture("agregados-propria-no-modelo-detalhes.json"));

    const result = await adapter.lookup("ABC1234");

    expect(result).toMatchObject({
      status: "found",
      fields: { model: "GOL 1.0", version: "1.0 FLEX 12V 4P" },
    });
  });

  it("treats placeholder strings and zero displacement as absent", async () => {
    const { adapter } = adapterFor(loadFixture("agregados-propria-placeholders.json"));

    const result = await adapter.lookup("ABC1234");

    expect(result.status).toBe("found");
    if (result.status !== "found") {
      return;
    }
    expect(result.fields.make).toBe("VW");
    expect(result.fields.model).toBe("GOL 1.0");
    expect(result.fields.year).toBe(2021);
    expect(result.fields.version).toBeUndefined();
    expect(result.fields.fuel).toBeUndefined();
    expect(result.fields.displacementCc).toBeUndefined();
  });

  it("maps a live unregistered plate as not_found without billing", async () => {
    const { adapter } = adapterFor(loadFixture("agregados-propria-empty-data.json"));

    const result = await adapter.lookup("AAA0000");

    expect(result.status).toBe("not_found");
    expect(result).toMatchObject({ billed: false, provider: "agregados-propria" });
    expect(result).not.toHaveProperty("fields");
  });

  it("maps 402 to exhausted_balance", async () => {
    const { adapter, fetchImpl } = adapterFor(
      loadFixture("agregados-propria-insufficient-balance.json"),
    );

    const result = await adapter.lookup("ABC1234");

    expect(result).toMatchObject({
      status: "failed",
      reason: "exhausted_balance",
      billed: false,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("maps 422 to provider_error without billing", async () => {
    const { adapter } = adapterFor(loadFixture("agregados-propria-invalid-plate.json"));

    expect(await adapter.lookup("ABC1234")).toMatchObject({
      status: "failed",
      reason: "provider_error",
      billed: false,
    });
  });

  it("maps 403 to not_configured", async () => {
    const { adapter } = adapterFor(loadFixture("agregados-propria-pj-required.json"));

    expect(await adapter.lookup("ABC1234")).toMatchObject({
      status: "failed",
      reason: "not_configured",
      billed: false,
    });
  });

  it("returns not_configured without fetching when the token is blank", async () => {
    const fetchImpl = vi.fn();
    const adapter = createAgregadosPropriaAdapter({ token: "  ", fetch: fetchImpl });

    expect(await adapter.lookup("ABC1234")).toMatchObject({
      status: "failed",
      reason: "not_configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("a 200 that is not a JSON envelope is a provider error, not a miss", () => {
  // Ruling 3f. A gateway that answers 200 with an HTML error page used to become
  // a permanent `not_found`: `readJsonBody` returns undefined, the empty field set
  // reads as a miss, and `plate-lookup/spec.md:55` stores a miss forever — so that
  // plate could never be looked up again. Line 57 already says a provider error is
  // not stored "because it says nothing about the plate", and line 55 defines a
  // miss as every hop that **actually answered** returning no usable field. A
  // gateway page did not answer.
  function adapterReturning(response: Response) {
    return createAgregadosPropriaAdapter({ token: "test-token", fetch: vi.fn(async () => response) });
  }

  it.each([
    { name: "an HTML gateway page", body: "<html><body>502 Bad Gateway</body></html>", type: "text/html" },
    { name: "an empty body", body: "", type: "application/json" },
    { name: "truncated JSON", body: '{"data": {', type: "application/json" },
  ])("refuses $name rather than remembering the plate as absent", async ({ body, type }) => {
    const adapter = adapterReturning(
      new Response(body, { status: 200, headers: { "content-type": type } }),
    );

    const result = await adapter.lookup("ABC1234");

    expect(result.status).toBe("failed");
    // The reason matters as much as the status: only `provider_error` keeps the
    // plate out of the permanent store, and asserting `status` alone would pass
    // on `exhausted_balance`, which is surfaced very differently.
    expect(result).toMatchObject({ status: "failed", reason: "provider_error" });
  });

  it("still treats a well-formed 200 with no vehicle as a miss", async () => {
    const adapter = adapterReturning(
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    // The complement of the cases above, and the reason the guard checks the
    // envelope rather than the fields: here the provider did answer, in JSON, and
    // said it has nothing. That is a miss and should be remembered.
    expect((await adapter.lookup("ABC1234")).status).toBe("not_found");
  });
});
