/**
 * Test design (testing-strategy)
 *
 * Setup: createHttpOmieAdapter with injected fetch/sleep/errorSink. No real
 * sockets. Clock is injected `now` so throttle math is deterministic.
 *
 * Oracle: omie-http-adapter omie-sync (HTTP adapter without CI network) and
 * design.md D6 — page 100, 1 in-flight, 300ms, 429 1s/2s/4s × 3 honor
 * Retry-After, 425 non-retryable IntegrationError, no in-process 425 wait.
 *
 * Axes
 *   A1 HTTP status — 200 / 429 / 425 / other 4xx
 *   A2 429 sequence — recover on attempt 2 / exhaust 3 / Retry-After present
 *   A3 throttle — first call vs second call (300ms)
 *   A4 call name — ConsultarCliente / AlterarCliente / ListarClientes / IncluirCliente
 *   BVA: attempts 2 (recover), 3 (last), 4 forbidden; Retry-After 0 vs 8s
 *
 * Outputs: O1 JSON mapped; O2 throw omie_429 + retryable error; O3 throw
 *   omie_425 + non-retryable error; O4 sleep delays; O5 request body
 *
 * Sampled-cell
 *   get maps ConsultarCliente               | A4 get     | O1 | wrong call / telefone
 *   put sends AlterarCliente + integracao   | A4 put     | O5 | missing codigo_integracao
 *   put omits unwritten fields              | A4 put     | O5 | "" wipes other Omie fields
 *   put of a cleared name sends ""          | A4 put     | O5 | omit razao_social when CRM null
 *   put all-unmappable skips the call       | A4 put     | O5 | empty AlterarCliente sent
 *   listPage size 100                       | A4 list    | O5 | registros_por_pagina != 100
 *   incluir sends codigo_integracao         | A4 incluir | O5 | CRM id missing
 *   429 then 200 sleeps 1000                | A2 recover | O4 | sleep != 1s or calls != 2
 *   429 × 3 records retryable               | A2 exhaust | O2 | 4th fetch or retryable false
 *   Retry-After 8 overrides 1s              | A2 header  | O4 | sleep 1000
 *   425 records non-retryable, no long wait | A1 425     | O3 | sleep >= 30min or retryable
 *   404 throws omie_http_404                | A1 other   | O1 | 200 or 429 path
 *   listPage incremental filter             | A4 list    | O5 | missing filtrar_por_data
 *   second call throttles 300ms             | A3 second  | O4 | no 300 sleep
 *   sanitize strips secret and taxId        | sink msg   | O5 | raw key or 14 digits
 *
 * Decision / branch map (http.ts)
 *   wait > 0 throttle          T second-call it; F first get it
 *   status === 425             T 425 it; F 200/429 its
 *   status === 429             T 429 its; F 200 its
 *   attempt >= max on 429      T exhaust it; F recover it
 *   Retry-After parse ok       T header it; F recover uses 1s
 *   faultstring present        T (covered via 200 fault in get? add it); F happy get
 *   !response.ok               T 404 it; F 200
 *   filter?.alteredAfter       T incremental-filter it; F listPage size 100
 *   incluir missing omie id    T no-id it; F incluir it
 *   caracteristicas array vs wrap — wrap in list unwrap it; array in bare-array it
 *   codigoIntegracao on put    T AlterarCliente it; F omit-integracao it
 *   !errorSink                 not sampled — optional inject; 425/429 its pass a sink
 *   parseRetryAfter invalid    F recover it (no header); T header it; seconds<0 out of scope
 *   toWire !mapped.ok in put   T all-unmappable-skip it; F happy put its
 *   written.length === 0       T all-unmappable-skip it; F happy put its
 *   written empty scalar       T cleared-name it; F postalCode it
 *
 * Out of scope: live Omie; engine decideField (engine.test.ts); Prisma sink.
 */
import { describe, expect, it } from "vitest";
import type { IntegrationErrorInput } from "./adapter.js";
import { createHttpOmieAdapter, OMIE_CLIENTS_URL, OMIE_LIST_PAGE_SIZE } from "./http.js";
import { emptySnapshot } from "./map.js";

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function createAdapter(fetchImpl: typeof fetch, extras?: {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  errors?: IntegrationErrorInput[];
}) {
  const errors = extras?.errors ?? [];
  return createHttpOmieAdapter({
    appKey: "key-secret",
    appSecret: "super-secret",
    fetch: fetchImpl,
    sleep: extras?.sleep ?? (async () => undefined),
    now: extras?.now ?? (() => 0),
    errorSink: {
      async record(error) {
        errors.push(error);
      },
    },
  });
}

describe("HttpOmieAdapter", () => {
  it("maps ConsultarCliente telefone1 into the snapshot", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        codigo_cliente_omie: 99,
        razao_social: "Ana",
        telefone1_ddd: "11",
        telefone1_numero: "988887777",
      });
    const adapter = createAdapter(fetchImpl as typeof fetch);

    const snapshot = await adapter.get("99");

    expect(snapshot?.razao_social).toBe("Ana");
    expect(snapshot?.telefone).toBe("11988887777");
  });

  it("sends AlterarCliente with codigo_cliente_integracao and the CRM postalCode", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ codigo_cliente_omie: 9 });
    };
    const adapter = createAdapter(fetchImpl as typeof fetch);

    await adapter.put("9", { postalCode: "22041080" }, "cus-1");

    const body = bodies[0] as { call: string; param: Array<Record<string, unknown>> };
    expect(body.call).toBe("AlterarCliente");
    expect(body.param[0]?.codigo_cliente_integracao).toBe("cus-1");
    expect(body.param[0]?.cep).toBe("22041080");
  });

  it("put omits every field it is not writing", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ codigo_cliente_omie: 9 });
    };
    const adapter = createAdapter(fetchImpl as typeof fetch);

    await adapter.put("9", { postalCode: "22041080" }, "cus-1");

    const param = (bodies[0] as { param: Array<Record<string, unknown>> }).param[0] ?? {};
    expect(Object.keys(param).sort()).toEqual([
      "cep",
      "codigo_cliente_integracao",
      "codigo_cliente_omie",
    ]);
  });

  it("put of a cleared name sends an empty razao_social and still omits every other client field", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ codigo_cliente_omie: 9 });
    };
    const adapter = createAdapter(fetchImpl as typeof fetch);

    await adapter.put("9", { name: null }, "cus-1");

    const param = (bodies[0] as { param: Array<Record<string, unknown>> }).param[0] ?? {};
    expect(param.razao_social).toBe("");
    expect(Object.keys(param).sort()).toEqual([
      "codigo_cliente_integracao",
      "codigo_cliente_omie",
      "razao_social",
    ]);
  });

  it("put with no mappable field makes no Omie call", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse({ codigo_cliente_omie: 9 });
    };
    const adapter = createAdapter(fetchImpl as typeof fetch);

    const result = await adapter.put("9", { model: "x".repeat(61) }, "cus-1");

    expect(calls).toBe(0);
    expect(result.failedKeys).toEqual(["model"]);
  });

  it("lists with page size 100 and unwraps caracteristica", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({
        pagina: 1,
        total_de_paginas: 1,
        clientes_cadastro: [
          {
            codigo_cliente_omie: 1,
            razao_social: "Bia",
            caracteristicas: { caracteristica: [{ campo: "Placa", conteudo: "ABC1D23" }] },
          },
        ],
      });
    };
    const adapter = createAdapter(fetchImpl as typeof fetch);

    const page = await adapter.listPage(1);

    const body = bodies[0] as { call: string; param: Array<Record<string, unknown>> };
    expect(body.call).toBe("ListarClientes");
    expect(body.param[0]?.registros_por_pagina).toBe(OMIE_LIST_PAGE_SIZE);
    expect(page.clients[0]?.snapshot.caracteristicas[0]?.conteudo).toBe("ABC1D23");
  });

  it("sends IncluirCliente with codigo_cliente_integracao equal to the CRM id", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ codigo_cliente_omie: 77 });
    };
    const adapter = createAdapter(fetchImpl as typeof fetch);

    const created = await adapter.incluir({
      codigoIntegracao: "cus-crm",
      snapshot: { ...emptySnapshot(), razao_social: "Cris" },
    });

    const body = bodies[0] as { call: string; param: Array<Record<string, unknown>> };
    expect(body.call).toBe("IncluirCliente");
    expect(body.param[0]?.codigo_cliente_integracao).toBe("cus-crm");
    expect(created.omieId).toBe("77");
  });

  it("retries a 429 then succeeds after the 1s backoff", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({}, 429);
      }
      return jsonResponse({ codigo_cliente_omie: 1, razao_social: "Ana" });
    };
    const adapter = createAdapter(fetchImpl as typeof fetch, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await adapter.get("1");

    expect(calls).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  it("records a retryable IntegrationError after three 429s and does not fetch a fourth time", async () => {
    const errors: IntegrationErrorInput[] = [];
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse({ faultstring: "Too Many Requests key-secret 12345678901" }, 429);
    };
    const adapter = createAdapter(fetchImpl as typeof fetch, { errors });

    await expect(adapter.get("1")).rejects.toThrow("omie_429");
    expect(calls).toBe(3);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.retryable).toBe(true);
    expect(errors[0]?.attemptCount).toBe(3);
    expect(errors[0]?.code).toBe("omie_429");
    expect(errors[0]?.message).not.toContain("key-secret");
    expect(errors[0]?.message).not.toContain("12345678901");
    expect(errors[0]?.message).toContain("***01");
  });

  it("honors Retry-After seconds instead of the default 1s backoff", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({}, 429, { "retry-after": "8" });
      }
      return jsonResponse({ codigo_cliente_omie: 1 });
    };
    const adapter = createAdapter(fetchImpl as typeof fetch, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await adapter.get("1");

    expect(sleeps).toEqual([8000]);
  });

  it("records a non-retryable IntegrationError on 425 and does not sleep a lockout duration", async () => {
    const errors: IntegrationErrorInput[] = [];
    const sleeps: number[] = [];
    const fetchImpl = async () => jsonResponse("locked", 425);
    const adapter = createAdapter(fetchImpl as typeof fetch, {
      errors,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(adapter.get("1")).rejects.toThrow("omie_425");
    expect(errors[0]?.retryable).toBe(false);
    expect(errors[0]?.code).toBe("omie_425");
    expect(sleeps.every((ms) => ms < 30 * 60 * 1000)).toBe(true);
  });

  it("waits 300ms before a second Omie call", async () => {
    const sleeps: number[] = [];
    let now = 0;
    const fetchImpl = async () => jsonResponse({ codigo_cliente_omie: 1, razao_social: "Ana" });
    const adapter = createAdapter(fetchImpl as typeof fetch, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    await adapter.get("1");
    now = 0;
    await adapter.get("1");

    expect(sleeps).toEqual([300]);
  });

  it("posts only to the clientes endpoint", async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string | URL) => {
      urls.push(String(url));
      return jsonResponse({ codigo_cliente_omie: 1 });
    };
    const adapter = createAdapter(fetchImpl as typeof fetch);

    await adapter.get("1");

    expect(urls).toEqual([OMIE_CLIENTS_URL]);
    expect(urls.some((url) => url.includes("/servicos/os/"))).toBe(false);
  });

  it("throws when IncluirCliente omits codigo_cliente_omie", async () => {
    const errors: IntegrationErrorInput[] = [];
    const fetchImpl = async () => jsonResponse({});
    const adapter = createAdapter(fetchImpl as typeof fetch, { errors });

    await expect(
      adapter.incluir({ codigoIntegracao: "cus", snapshot: emptySnapshot() }),
    ).rejects.toThrow("omie_incluir_no_id");
    expect(errors[0]?.code).toBe("omie_incluir_no_id");
  });

  it("throws a sanitized faultstring on HTTP 200 Omie fault", async () => {
    const fetchImpl = async () =>
      jsonResponse({ faultstring: "erro cnpj 12345678901234 super-secret" });
    const adapter = createAdapter(fetchImpl as typeof fetch);

    await expect(adapter.get("1")).rejects.toThrow(/erro cnpj \*\*\*34 \[redacted\]/);
  });

  it("throws omie_http_404 when ConsultarCliente returns 404 without a faultstring", async () => {
    const fetchImpl = async () => jsonResponse({ codigo_cliente_omie: 1 }, 404);
    const adapter = createAdapter(fetchImpl as typeof fetch);

    await expect(adapter.get("1")).rejects.toThrow("omie_http_404");
  });

  it("lists caracteristicas when Omie sends a bare array", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        pagina: 1,
        total_de_paginas: 1,
        clientes_cadastro: [
          {
            codigo_cliente_omie: 2,
            caracteristicas: [{ campo: "Placa", conteudo: "XYZ9A87" }],
          },
        ],
      });
    const adapter = createAdapter(fetchImpl as typeof fetch);

    const page = await adapter.listPage(1);

    expect(page.clients[0]?.snapshot.caracteristicas[0]?.conteudo).toBe("XYZ9A87");
  });

  it("omits codigo_cliente_integracao when put is called without a CRM id", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ codigo_cliente_omie: 9 });
    };
    const adapter = createAdapter(fetchImpl as typeof fetch);

    await adapter.put("9", { postalCode: "22041080" });

    const body = bodies[0] as { param: Array<Record<string, unknown>> };
    expect(body.param[0]?.codigo_cliente_integracao).toBeUndefined();
    expect(body.param[0]?.cep).toBe("22041080");
  });

  it("sends filtrar_por_data_alteracao when listPage receives alteredAfter", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ pagina: 1, total_de_paginas: 1, clientes_cadastro: [] });
    };
    const adapter = createAdapter(fetchImpl as typeof fetch);

    await adapter.listPage(1, { alteredAfter: "2026-08-01" });

    const body = bodies[0] as { param: Array<Record<string, unknown>> };
    expect(body.param[0]?.filtrar_por_data_alteracao).toBe("S");
    expect(body.param[0]?.filtrar_por_data_de).toBe("2026-08-01");
  });
});
