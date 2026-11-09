/**
 * HTTP client for the Tecfil Catálogo Expresso data API
 * (`catalogoexpresso.com.br/ideia2001/api/v2`). Sends the tenant key and
 * `idm=pt` on every request; retries 5xx responses and transient network
 * errors; decodes the obfuscated response body via `decode.ts`.
 */

import { decodeTecfilBody } from "./decode.js";

/** Tecfil's own catalogue host. The default, and the only host a deployment should normally use. */
export const TECFIL_DEFAULT_BASE_URL = "https://catalogoexpresso.com.br/ideia2001/api/v2";

/**
 * Where the client sends its requests.
 *
 * Read per call rather than once at import, so a test process can point the client somewhere
 * else after this module is already loaded — which is the whole reason the override exists.
 *
 * Same seam and same reason as `MOTUL_BASE_URL`: the API is free and its tenant key is
 * public, so there is no credential to blank. Redirecting the host is the only way a test
 * run can be kept off Tecfil's production catalogue.
 */
function baseUrl(): string {
  const raw = process.env.TECFIL_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : TECFIL_DEFAULT_BASE_URL;
}
// Tenant identity, not a credential — published in every request the public
// site itself makes. See docs/tecfil-catalogo-expresso-api.md#authentication.
const CHAVE_PERFIL = "8e8539e2-7a58-493e-9eb8-e3ebba1f93de";
const MAX_RETRIES = 2;
const BACKOFF_MS = [200, 600] as const;
const REQUEST_TIMEOUT_MS = 8_000;

/** Error thrown when Tecfil returns a non-retryable HTTP status or exhausts retries on 5xx. */
export class TecfilError extends Error {
  constructor(
    public path: string,
    public status: number,
  ) {
    super(`tecfil ${path} status:${status}`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNetworkError(err: unknown) {
  return err instanceof Error && err.name === "AbortError";
}

function logRetry(path: string, attempt: number, err: unknown) {
  const status = err instanceof TecfilError ? err.status : undefined;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`tecfil: retry ${attempt}/${MAX_RETRIES} for ${path}`, {
    status,
    error: message,
  });
}

/**
 * GET helper for the Tecfil `/consulta` endpoint family: 8s per-attempt
 * timeout, tenant key and `idm=pt` on every request, up to two retries on
 * network errors, timeouts, and 5xx, and the obfuscated body decoded before
 * returning.
 *
 * @param path - Path under the API base (no leading slash), e.g. `"consulta"`.
 * @param params - Extra query pairs; `chavePerfil` and `idm` are always overwritten to the tenant key and `pt`.
 * @returns Decoded JSON body as `T` (see {@link decodeTecfilBody}).
 * @throws {@link TecfilError} on 4xx immediately; after retries on persistent 5xx.
 * @throws The original network/`AbortError`, or a `TecfilDecodeError`, when retries are exhausted or the body cannot be decoded.
 */
export async function tecfilGet<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(`${baseUrl()}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  url.searchParams.set("chavePerfil", CHAVE_PERFIL);
  url.searchParams.set("idm", "pt");

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const text = await res.text();
        return decodeTecfilBody(text) as T;
      }
      if (res.status < 500) throw new TecfilError(path, res.status);
      if (attempt < MAX_RETRIES) {
        logRetry(path, attempt + 1, new TecfilError(path, res.status));
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      throw new TecfilError(path, res.status);
    } catch (err) {
      if (err instanceof TecfilError && err.status < 500) throw err;
      const retryable =
        err instanceof TecfilError ||
        err instanceof TypeError ||
        isRetryableNetworkError(err);
      if (attempt < MAX_RETRIES && retryable) {
        logRetry(path, attempt + 1, err);
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      throw err;
    }
  }

  throw new Error("tecfilGet: unreachable");
}
