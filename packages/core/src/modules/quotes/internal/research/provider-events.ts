/**
 * What a research run learns from the provider's refusals (background-oil-research D8, D9).
 *
 * The ports turn every failed call into an ordinary failure value (an unread source, a declined
 * escalation), so the pipeline's result cannot say WHY a call failed. The runner needs to: a
 * refused key or an exhausted balance pauses research for every identity, a rate limit releases
 * the run, and a refused request parameter is an outage of this run only. So each OpenAI
 * request's refusal is reported to the run, by a tap on the transport (production) or by a fake
 * port (tests), and the runner classifies what it heard once the run returns.
 *
 * The codes are OpenAI's (developers.openai.com error codes and rate-limit guide): a refused key
 * answers 401 `invalid_api_key`; a spent quota answers 429 `insufficient_quota`, which is not a
 * rate limit and is never retried; a rate limit answers 429 `rate_limit_exceeded` or `slow_down`
 * with `Retry-After`; a parameter the model refuses answers 400 `unsupported_value` or
 * `unsupported_parameter`; a model the project cannot use answers 404 `model_not_found`.
 */
import { openaiBaseUrl } from "../model-calls/research-model.js";

/** One refused OpenAI request, as the transport saw it. */
export type ProviderEvent = {
  status: number;
  /** The provider's error code, from the body (`{"error": {"code": "insufficient_quota", …}}`). */
  code?: string;
  /** `Retry-After`, in milliseconds, on a 429. */
  retryAfterMs?: number;
  /** The start of the body, for the log. */
  body?: string;
  /**
   * Which call this was: the same for a request and its retries (the URL and the body). A 2xx
   * with the same key withdraws the call's earlier refusal.
   */
  call?: string;
  /**
   * An error part inside a 2xx stream: the HTTP status says nothing, so it is classified by its
   * code alone, and it never withdraws an earlier refusal of the call.
   */
  inStream?: true;
};

/** Where a run's ports report a refusal. */
export type ProviderReport = (event: ProviderEvent) => void;

/** The codes OpenAI answers a request parameter it refuses with (HTTP 400). */
export const REFUSED_PARAMETER_CODES: readonly string[] = ["unsupported_parameter", "unsupported_value", "invalid_value"];

/**
 * The error codes that refuse the ACCOUNT rather than limit its rate, so waiting a minute does
 * not clear them: each pauses research like a refused key (D9). `insufficient_quota` is the spent
 * quota (HTTP 429); `billing_not_active` the account whose billing is off; `model_not_found` the
 * model the project cannot use (HTTP 404), the "model outside its plan" of the spec.
 */
export const ACCOUNT_REFUSED_CODES: readonly string[] = ["insufficient_quota", "billing_not_active", "model_not_found"];

/** Codes that mean a refused key, whatever the status they arrive with. */
export const AUTH_REFUSED_CODES: readonly string[] = ["invalid_api_key", "invalid_authentication", "incorrect_api_key", "invalid_organization"];

/** Codes that are a rate limit: release the run, due at `Retry-After`. */
export const RATE_LIMIT_CODES: readonly string[] = ["rate_limit_exceeded", "slow_down"];

/**
 * - `provider`: a refused key (401, 403), or an error that refuses the account (the spent quota,
 *   the billing, the model access) — pause research (D9, step 3);
 * - `rate_limit`: any other 429 — release the run, due at `Retry-After` (D8);
 * - `refused_parameter`: 400 with a refused-parameter code — an outage of this run, its body
 *   logged (D9);
 * - `other`: anything else — the pipeline's own outcome stands.
 */
export type RefusalKind = "provider" | "rate_limit" | "refused_parameter" | "other";

/** An error part inside a 2xx stream, by its code alone (review of #190). */
function classifyStreamError(code: string | undefined): RefusalKind {
  if (code === undefined) return "other";
  if (AUTH_REFUSED_CODES.includes(code) || ACCOUNT_REFUSED_CODES.includes(code)) return "provider";
  if (RATE_LIMIT_CODES.includes(code)) return "rate_limit";
  if (REFUSED_PARAMETER_CODES.includes(code)) return "refused_parameter";
  return "other";
}

/** @returns What one refusal means for the run. */
export function classifyRefusal(event: ProviderEvent): RefusalKind {
  if (event.inStream) return classifyStreamError(event.code);
  if (event.status === 401 || event.status === 403) return "provider";
  if (event.status === 429) return event.code !== undefined && ACCOUNT_REFUSED_CODES.includes(event.code) ? "provider" : "rate_limit";
  if (event.status === 404 && event.code !== undefined && ACCOUNT_REFUSED_CODES.includes(event.code)) return "provider";
  if (event.status === 400 && event.code !== undefined && ACCOUNT_REFUSED_CODES.includes(event.code)) return "provider";
  if (event.status === 400 && event.code !== undefined && REFUSED_PARAMETER_CODES.includes(event.code)) return "refused_parameter";
  return "other";
}

/** What a run heard, strongest first: a provider-wide refusal outranks a rate limit, which outranks a refused parameter. */
export type RunRefusals = {
  provider: ProviderEvent | null;
  rateLimit: ProviderEvent | null;
  refusedParameter: ProviderEvent | null;
};

/**
 * A run's collector: `report` is handed to the ports, `heard` read by the runner afterwards.
 *
 * Classified from each call's FINAL result (review of #186): a refusal reported with a `call` key
 * is withdrawn when a later 2xx arrives for the same call — a 429 the extractor or the web-search
 * loop retried to success is not a rate limit that survived the retries (D8). A refusal with no
 * key is never withdrawn.
 */
export function collectRefusals(): { report: ProviderReport; heard: () => RunRefusals } {
  const refused: { event: ProviderEvent; kind: RefusalKind }[] = [];
  return {
    report: (event) => {
      if (event.status >= 200 && event.status < 300 && !event.inStream) {
        if (event.call === undefined) return;
        for (let i = refused.length - 1; i >= 0; i -= 1) if (refused[i]!.event.call === event.call) refused.splice(i, 1);
        return;
      }
      const kind = classifyRefusal(event);
      if (kind !== "other") refused.push({ event, kind });
    },
    heard: () => ({
      provider: refused.find((entry) => entry.kind === "provider")?.event ?? null,
      rateLimit: refused.filter((entry) => entry.kind === "rate_limit").at(-1)?.event ?? null,
      refusedParameter: refused.find((entry) => entry.kind === "refused_parameter")?.event ?? null,
    }),
  };
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** `Retry-After` as milliseconds: seconds, or an HTTP date. */
function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * The code of an error body: its JSON `error.code` (an HTTP error body), `code` (a stream `error`
 * event) or `response.error.code` (a `response.failed` event); else the first `"code"` in the text
 * (an SSE frame, a long body). A `null` code is no code.
 */
export function errorCodeOf(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown }; code?: unknown; response?: { error?: { code?: unknown } } };
    const code = parsed?.error?.code ?? parsed?.code ?? parsed?.response?.error?.code;
    if (code !== undefined && code !== null) return String(code);
  } catch {
    // Not one JSON object: the fallback below.
  }
  const found = /"code"\s*:\s*(?:"([^"]+)"|(\d+))/.exec(text);
  return found?.[1] ?? found?.[2];
}

/**
 * Reads a 2xx stream's copy for an error part. One is reported as an in-stream refusal; a stream
 * that ends clean withdraws the call's earlier refusal, as a 2xx does. A stream that fails or is
 * cut withdraws nothing: it was not a success.
 */
async function watchStream(stream: ReadableStream<Uint8Array>, status: number, call: string, report: ProviderReport): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  let failed: ProviderEvent | null = null;
  const inspect = (line: string) => {
    if (failed || !line.startsWith("data:") || !line.includes("error")) return;
    const data = line.slice(5).trim();
    const code = errorCodeOf(data);
    if (code !== undefined) failed = { status, call, code, inStream: true, body: data.slice(0, 500) };
  };
  try {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      lines.forEach(inspect);
    }
    inspect(pending);
  } catch {
    return;
  }
  report(failed ?? { status, call });
}

/**
 * Wraps a `fetch` so every refused request to the OpenAI endpoint is reported. A request to
 * another host — a web page — is not: a page's 401 is a website's, not the provider's key.
 *
 * @param base - The transport the request goes to.
 * @param report - The run's collector.
 */
export function tapProviderRefusals(base: typeof fetch, report: ProviderReport): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (!urlOf(input).startsWith(openaiBaseUrl())) return response;
    // A retry resends the same body: that identifies the call, so its 2xx withdraws its refusal.
    const call = `${urlOf(input)}\n${typeof init?.body === "string" ? init.body : ""}`;
    if (response.ok) {
      const streamed = response.body && (response.headers.get("content-type") ?? "").includes("text/event-stream");
      if (!streamed) {
        report({ status: response.status, call });
        return response;
      }
      // A 2xx stream can still carry an error part: it is read beside the caller, and the call's
      // earlier refusal is withdrawn only once the stream has ended clean (review of #190).
      const [mine, theirs] = response.body!.tee();
      void watchStream(mine, response.status, call, report);
      return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    let text = "";
    try {
      text = await response.clone().text();
    } catch {
      // A body that cannot be read still reports its status.
    }
    const code = errorCodeOf(text);
    const retry = retryAfterMs(response.headers.get("retry-after"), Date.now());
    report({ status: response.status, call, ...(code !== undefined ? { code } : {}), ...(retry !== undefined ? { retryAfterMs: retry } : {}), body: text.slice(0, 500) });
    return response;
  };
}
