/**
 * Production HTTP Omie adapter — throttled JSON-RPC calls with 429 backoff and secret redaction in errors.
 */
import type { OmieSharedFieldKey } from "../../../shared/web/omie-field-keys.js";
import type { IntegrationErrorSink, OmieAdapter, OmieListedClient, OmiePutResult, OmieSyncPort } from "./adapter.js";
import { SHARED_FIELD_KEYS } from "./fields.js";
import { applyWireToSnapshot, emptySnapshot, toWire, type CrmFieldValue } from "./map.js";
import { sanitizeOmieText } from "./sanitize.js";
import { readBody, parseRetryAfter, mapCliente, writtenFieldsToOmieParam, snapshotToOmieParam } from "./http-wire.js";

/** Omie JSON-RPC endpoint for client consult, alter, list, and include calls. */
export const OMIE_CLIENTS_URL = "https://app.omie.com.br/api/v1/geral/clientes/";
/** Page size passed as `registros_por_pagina` on ListarClientes. */
export const OMIE_LIST_PAGE_SIZE = 100;
/** Minimum gap between consecutive Omie HTTP calls to respect rate limits. */
export const OMIE_THROTTLE_MS = 300;
/** Default backoff delays in ms when Omie returns 429 without a Retry-After header. */
export const OMIE_429_BACKOFF_MS = [1000, 2000, 4000] as const;
/** Maximum retry attempts for a single Omie call before surfacing omie_429. */
export const OMIE_429_MAX_ATTEMPTS = 3;

type OmieCall = "ConsultarCliente" | "AlterarCliente" | "ListarClientes" | "IncluirCliente";

/**
 * Creates a throttled `OmieSyncPort` that calls the live Omie clientes JSON-RPC API.
 *
 * @param options.appKey - Omie application key; must not be empty.
 * @param options.appSecret - Omie application secret; redacted from logged errors.
 * @param options.fetch - Optional `fetch` override for tests.
 * @param options.sleep - Optional delay function for throttle and 429 backoff; defaults to `setTimeout`.
 * @param options.errorSink - Optional sink receiving sanitized integration errors on 425/429 and incluir failures.
 * @param options.now - Optional clock for throttle spacing; defaults to `Date.now`.
 * @returns `OmieSyncPort` implementing `get`, `put`, `listPage`, and `incluir` with rate limiting and 429 retries.
 * @throws Omie faults (`omie_425`, `omie_429`, `omie_incluir_no_id`, sanitized `faultstring`) from returned port methods.
 */
export function createHttpOmieAdapter(options: {
  appKey: string;
  appSecret: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  errorSink?: IntegrationErrorSink;
  now?: () => number;
}): OmieSyncPort {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const secrets = [options.appKey, options.appSecret];
  let chain = Promise.resolve();
  let lastCallAt: number | null = null;

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      const wait = lastCallAt === null ? 0 : lastCallAt + OMIE_THROTTLE_MS - now();
      if (wait > 0) {
        await sleep(wait);
      }
      try {
        return await work();
      } finally {
        lastCallAt = now();
      }
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function record(error: {
    operation: string;
    code: string;
    message: string;
    retryable: boolean;
    attemptCount: number;
  }) {
    if (!options.errorSink) {
      return;
    }
    await options.errorSink.record({
      ...error,
      message: sanitizeOmieText(error.message, secrets),
    });
  }

  async function post(call: OmieCall, param: Record<string, unknown>): Promise<unknown> {
    return enqueue(() => postWithRetry(call, param));
  }

  async function postWithRetry(call: OmieCall, param: Record<string, unknown>): Promise<unknown> {
    let attempt = 0;
    while (attempt < OMIE_429_MAX_ATTEMPTS) {
      attempt += 1;
      const response = await doFetch(OMIE_CLIENTS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          call,
          app_key: options.appKey,
          app_secret: options.appSecret,
          param: [param],
        }),
      });
      if (response.status === 425) {
        const body = await readBody(response);
        await record({
          operation: call,
          code: "omie_425",
          message: body || "omie lockout 425",
          retryable: false,
          attemptCount: attempt,
        });
        throw new Error("omie_425");
      }
      if (response.status === 429) {
        if (attempt >= OMIE_429_MAX_ATTEMPTS) {
          const body = await readBody(response);
          await record({
            operation: call,
            code: "omie_429",
            message: body || "omie rate limit 429",
            retryable: true,
            attemptCount: attempt,
          });
          throw new Error("omie_429");
        }
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        const backoff = retryAfter ?? OMIE_429_BACKOFF_MS[attempt - 1] ?? 4000;
        await sleep(backoff);
        continue;
      }
      const json = (await response.json()) as Record<string, unknown>;
      if (typeof json.faultstring === "string" || typeof json.faultcode === "string") {
        throw new Error(sanitizeOmieText(String(json.faultstring ?? json.faultcode), secrets));
      }
      if (!response.ok) {
        throw new Error(`omie_http_${response.status}`);
      }
      return json;
    }
    throw new Error("omie_429");
  }

  const adapter: OmieAdapter & OmieSyncPort = {
    async get(omieId) {
      const json = (await post("ConsultarCliente", { codigo_cliente_omie: Number(omieId) })) as Record<
        string,
        unknown
      >;
      return mapCliente(json).snapshot;
    },
    async put(omieId, fields, codigoIntegracao): Promise<OmiePutResult> {
      const snapshot = emptySnapshot();
      const failedKeys: OmieSharedFieldKey[] = [];
      const reasons: Partial<Record<OmieSharedFieldKey, string>> = {};
      const written: OmieSharedFieldKey[] = [];
      for (const key of SHARED_FIELD_KEYS) {
        if (!Object.hasOwn(fields, key)) {
          continue;
        }
        const value = fields[key] as CrmFieldValue;
        const mapped = toWire(key, value);
        if (!mapped.ok) {
          failedKeys.push(key);
          reasons[key] = "wire_mapping_failed";
          continue;
        }
        applyWireToSnapshot(snapshot, key, mapped.wire);
        written.push(key);
      }
      if (written.length === 0) {
        return failedKeys.length > 0 ? { failedKeys, reasons } : { failedKeys };
      }
      // AlterarCliente updates every field it is sent, so an unwritten field
      // must be absent from the param, not present as "" — "" would clear it.
      const param: Record<string, unknown> = {
        codigo_cliente_omie: Number(omieId),
        ...writtenFieldsToOmieParam(snapshot, written),
      };
      if (codigoIntegracao) {
        param.codigo_cliente_integracao = codigoIntegracao;
      }
      await post("AlterarCliente", param);
      return failedKeys.length > 0 ? { failedKeys, reasons } : { failedKeys };
    },
    async listPage(page, filter) {
      const param: Record<string, unknown> = {
        pagina: page,
        registros_por_pagina: OMIE_LIST_PAGE_SIZE,
        apenas_importado_api: "N",
      };
      if (filter?.alteredAfter) {
        param.filtrar_por_data_alteracao = "S";
        param.filtrar_por_data_de = filter.alteredAfter;
      }
      const json = (await post("ListarClientes", param)) as Record<string, unknown>;
      const rows = Array.isArray(json.clientes_cadastro) ? json.clientes_cadastro : [];
      const clients: OmieListedClient[] = [];
      for (const row of rows) {
        if (row && typeof row === "object") {
          clients.push(mapCliente(row as Record<string, unknown>));
        }
      }
      return {
        clients,
        page: Number(json.pagina ?? page),
        totalPages: Number(json.total_de_paginas ?? 1),
      };
    },
    async incluir(input) {
      const json = (await post("IncluirCliente", {
        codigo_cliente_integracao: input.codigoIntegracao,
        ...snapshotToOmieParam(input.snapshot),
      })) as Record<string, unknown>;
      const omieId = json.codigo_cliente_omie;
      if (omieId === undefined || omieId === null) {
        await record({
          operation: "IncluirCliente",
          code: "omie_incluir_no_id",
          message: "IncluirCliente returned no codigo_cliente_omie",
          retryable: false,
          attemptCount: 1,
        });
        throw new Error("omie_incluir_no_id");
      }
      return { omieId: String(omieId) };
    },
  };

  return adapter;
}
