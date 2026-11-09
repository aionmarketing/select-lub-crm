/**
 * Test design (testing-strategy) — what a refused OpenAI request means for a research run
 *
 * SUT: `classifyRefusal`, `collectRefusals` and `tapProviderRefusals`. A fake transport; no socket.
 *
 * Oracle: background-oil-research D8 and D9, with OpenAI's codes (switch-oil-research-to-openai,
 *   `oil-research` delta): a `401` or `403` (a refused key, `invalid_api_key`), and an error that
 *   refuses the account rather than limits its rate — `insufficient_quota` (HTTP 429, a spent
 *   quota), `billing_not_active`, `model_not_found` (HTTP 404, a model the project cannot use) —
 *   are provider-wide (pause research); any other `429` (`rate_limit_exceeded`, `slow_down`, no
 *   code) is a rate limit (release, due at `Retry-After`); HTTP 400 with `unsupported_parameter`,
 *   `unsupported_value` or `invalid_value` is a refused request parameter (an outage of this run,
 *   its body logged), never a provider pause. A page's 401 is a website's, not the provider's:
 *   only requests to the OpenAI base URL are reported. The code is read from the JSON body, else
 *   by a `"code": …` fallback (a long or SSE-framed body). An error part inside a 200 stream is
 *   classified by its code alone and never withdraws the call's earlier refusal; a stream that
 *   ends clean does (review of #190).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENAI_DEFAULT_BASE_URL } from "../model-calls/research-model.js";
import { classifyRefusal, collectRefusals, tapProviderRefusals, type ProviderEvent } from "./provider-events.js";

const URL_OF_OPENAI = `${OPENAI_DEFAULT_BASE_URL}/responses`;

afterEach(() => {
  delete process.env.OPENAI_BASE_URL;
});

describe("classifyRefusal", () => {
  it.each([
    [{ status: 401 }, "provider"],
    [{ status: 403 }, "provider"],
    [{ status: 401, code: "invalid_api_key" }, "provider"],
    [{ status: 429, code: "insufficient_quota" }, "provider"],
    [{ status: 429, code: "billing_not_active" }, "provider"],
    [{ status: 404, code: "model_not_found" }, "provider"],
    [{ status: 400, code: "billing_not_active" }, "provider"],
    [{ status: 429, code: "rate_limit_exceeded" }, "rate_limit"],
    [{ status: 429, code: "slow_down" }, "rate_limit"],
    [{ status: 429 }, "rate_limit"],
    [{ status: 400, code: "unsupported_value" }, "refused_parameter"],
    [{ status: 400, code: "unsupported_parameter" }, "refused_parameter"],
    [{ status: 400, code: "invalid_value" }, "refused_parameter"],
    [{ status: 400, code: "context_length_exceeded" }, "other"],
    [{ status: 404 }, "other"],
    [{ status: 500 }, "other"],
    [{ status: 200, inStream: true, code: "insufficient_quota" }, "provider"],
    [{ status: 200, inStream: true, code: "rate_limit_exceeded" }, "rate_limit"],
    [{ status: 200, inStream: true, code: "server_error" }, "other"],
  ] as [ProviderEvent, string][])("%j is %s", (event, kind) => {
    expect(classifyRefusal(event)).toBe(kind);
  });
});

describe("tapProviderRefusals", () => {
  const answer = (status: number, body: string, headers: Record<string, string> = {}) => async () => new Response(body, { status, headers });

  it("reports a refused OpenAI request with its code, Retry-After and body, and hands the response on", async () => {
    const { report, heard } = collectRefusals();
    const tapped = tapProviderRefusals(answer(429, JSON.stringify({ error: { code: "rate_limit_exceeded", message: "busy" } }), { "retry-after": "30" }), report);

    const response = await tapped(URL_OF_OPENAI, { method: "POST" });

    expect(response.status).toBe(429);
    expect(await response.text()).toContain("busy");
    expect(heard().rateLimit).toMatchObject({ status: 429, code: "rate_limit_exceeded", retryAfterMs: 30_000 });
    expect(heard().provider).toBeNull();
  });

  it.each(["insufficient_quota", "billing_not_active"])("hears a 429 with code %s on the wire as a provider refusal, not a rate limit", async (code) => {
    const { report, heard } = collectRefusals();
    await tapProviderRefusals(answer(429, JSON.stringify({ error: { code, message: "account" } })), report)(URL_OF_OPENAI);

    expect(heard()).toMatchObject({ provider: { status: 429, code }, rateLimit: null });
  });

  it("hears a refused key and an unusable model as provider refusals", async () => {
    const key = collectRefusals();
    await tapProviderRefusals(answer(401, JSON.stringify({ error: { code: "invalid_api_key", message: "bad key" } })), key.report)(URL_OF_OPENAI);
    expect(key.heard().provider).toMatchObject({ status: 401, code: "invalid_api_key" });

    const model = collectRefusals();
    await tapProviderRefusals(answer(404, JSON.stringify({ error: { code: "model_not_found", message: "no access" } })), model.report)(URL_OF_OPENAI);
    expect(model.heard().provider).toMatchObject({ status: 404, code: "model_not_found" });
  });

  it("finds the code in a body too long to parse whole, and in an SSE-framed body", async () => {
    const long = collectRefusals();
    const padded = JSON.stringify({ error: { code: "insufficient_quota", message: "saldo".repeat(200) } }).slice(0, 700);
    await tapProviderRefusals(answer(429, padded), long.report)(URL_OF_OPENAI);
    expect(long.heard().provider).toMatchObject({ status: 429, code: "insufficient_quota" });

    const framed = collectRefusals();
    await tapProviderRefusals(answer(429, `data: {"error":{"code":"insufficient_quota","message":"quota"}}\n\n`), framed.report)(URL_OF_OPENAI);
    expect(framed.heard().provider).toMatchObject({ status: 429, code: "insufficient_quota" });
  });

  it("classifies an error part inside a 200 stream by its code, and it does not withdraw the call's earlier refusal", async () => {
    const { report, heard } = collectRefusals();
    const sse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    const replies = [
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429 }),
      sse(`data: {"type":"response.output_text.delta","delta":"…"}\n\ndata: {"type":"error","code":"insufficient_quota","message":"quota"}\n\n`),
    ];
    const tapped = tapProviderRefusals(async () => replies.shift()!, report);

    await tapped(URL_OF_OPENAI, { method: "POST", body: '{"call":1}' });
    const streamed = await tapped(URL_OF_OPENAI, { method: "POST", body: '{"call":1}' });
    expect(await streamed.text()).toContain("quota");
    await vi.waitFor(() => expect(heard().provider).toMatchObject({ code: "insufficient_quota", inStream: true }));
    expect(heard().rateLimit).toMatchObject({ status: 429, code: "rate_limit_exceeded" });
  });

  it("withdraws the call's earlier refusal once a 200 stream ends clean", async () => {
    const { report, heard } = collectRefusals();
    const replies = [
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429 }),
      new Response(`data: {"type":"response.output_text.delta","delta":"{}"}\n\ndata: {"type":"response.completed"}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ];
    const tapped = tapProviderRefusals(async () => replies.shift()!, report);

    await tapped(URL_OF_OPENAI, { method: "POST", body: '{"call":1}' });
    expect(heard().rateLimit).not.toBeNull();
    await (await tapped(URL_OF_OPENAI, { method: "POST", body: '{"call":1}' })).text();
    await vi.waitFor(() => expect(heard().rateLimit).toBeNull());
  });

  it("reports a refused parameter as such, not as a provider refusal", async () => {
    const { report, heard } = collectRefusals();
    await tapProviderRefusals(answer(400, JSON.stringify({ error: { code: "unsupported_value", message: "reasoning.effort not supported" } })), report)(URL_OF_OPENAI);

    expect(heard()).toMatchObject({ provider: null, refusedParameter: { status: 400, code: "unsupported_value" } });
    expect(heard().refusedParameter?.body).toContain("reasoning.effort not supported");
  });

  it("withdraws a 429 that a retry of the same call recovered, and keeps one on another call", async () => {
    const { report, heard } = collectRefusals();
    const statuses = [429, 200, 429];
    const tapped = tapProviderRefusals(async () => new Response("{}", { status: statuses.shift()! }), report);

    await tapped(URL_OF_OPENAI, { method: "POST", body: '{"call":1}' });
    await tapped(URL_OF_OPENAI, { method: "POST", body: '{"call":1}' });
    expect(heard().rateLimit).toBeNull();

    await tapped(URL_OF_OPENAI, { method: "POST", body: '{"call":2}' });
    expect(heard().rateLimit).toMatchObject({ status: 429 });
  });

  it("does not report a web page's refusal, nor an answered request", async () => {
    const { report, heard } = collectRefusals();
    await tapProviderRefusals(answer(401, "no"), report)("https://example.com/manual");
    await tapProviderRefusals(answer(200, "{}"), report)(URL_OF_OPENAI);

    expect(heard()).toEqual({ provider: null, rateLimit: null, refusedParameter: null });
  });

  it("follows OPENAI_BASE_URL: a request to the default host is then no longer the provider's", async () => {
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:18082/v1";
    const { report, heard } = collectRefusals();
    await tapProviderRefusals(answer(401, "no"), report)(URL_OF_OPENAI);
    expect(heard().provider).toBeNull();

    await tapProviderRefusals(answer(401, "no"), report)("http://127.0.0.1:18082/v1/responses");
    expect(heard().provider).toMatchObject({ status: 401 });
  });
});
