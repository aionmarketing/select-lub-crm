/**
 * Test design (testing-strategy)
 *
 * SUT: `createEvolutionSend`'s failure classification and time limits, with
 *   `vi.stubGlobal("fetch")` restored after each case. No live Evolution, no
 *   database.
 *
 * Oracle: `hold-unknown-outcome-sends`, whatsapp-channel "A send whose outcome
 *   is unknown is held for a person", and its design D2. Evolution v2.3.7's
 *   answers were read from its own source: `401`/`403`/`404` come from guards
 *   that run before the send; a `400` is either the pre-send "not on WhatsApp"
 *   (`response.message` of `{ exists: false }` entries) or the catch-all around
 *   the relay AND the work after it; its own `500`s cannot be told from a
 *   proxy's.
 *
 * Axes
 *   1. thrown before connecting (DNS, refused, unreachable, connect timeout,
 *      an AggregateError of those) → retryable
 *   2. thrown after connecting (reset, socket closed, a mixed AggregateError,
 *      a bare error) → unknown
 *   3. status: 401/403 → refused; 404 by body (the instance guard → disconnected,
 *      an unknown route, an empty or unreadable body → unknown; outbox-404-
 *      marks-disconnected); 400 by body; every 5xx →
 *      unknown
 *   4. 2xx: unreadable body → unknown
 *   5. the time limit: text uses the text limit, media the media limit; an
 *      expired limit is unknown
 *
 * Every case asserts the kind; none can pass on a constant, since each kind
 * appears on both sides of some pair.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvolutionSend } from "./evolution.js";

const text = { instanceName: "poc", number: "5511999999999", text: "oi" };
const image = { instanceName: "poc", number: "5511999999999", mediatype: "image" as const, media: "ZmFrZQ==" };

function socketError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** What undici's fetch rejects with: `TypeError: fetch failed`, the socket error as `cause`. */
function fetchFailed(cause: unknown): TypeError {
  return Object.assign(new TypeError("fetch failed"), { cause });
}

function rejectWith(error: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(error)));
}

function answer(status: number, json: () => Promise<unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json })));
}

/** A fetch that answers only when its signal aborts, or after `afterMs` with a provider id. */
function slowFetch(afterMs: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve({ ok: true, status: 201, json: async () => ({ key: { id: "evo-late" } }) }),
            afterMs,
          );
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          });
        }),
    ),
  );
}

describe("createEvolutionSend failure classification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const send = () => createEvolutionSend({ baseUrl: "http://evo.test", apiKey: "k" });

  it.each(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"])(
    "retries %s: the connection never opened",
    async (code) => {
      rejectWith(fetchFailed(socketError(code)));
      await expect(send().sendText(text)).resolves.toEqual({ ok: false, kind: "retryable", error: `network ${code}` });
    },
  );

  it("retries when every address of an AggregateError was refused", async () => {
    const cause = Object.assign(new AggregateError([socketError("ECONNREFUSED"), socketError("ECONNREFUSED")]), {
      code: "ECONNREFUSED",
    });
    rejectWith(fetchFailed(cause));
    await expect(send().sendText(text)).resolves.toMatchObject({ ok: false, kind: "retryable" });
  });

  it.each(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT"])(
    "holds %s as unknown: the request may have been written",
    async (code) => {
      rejectWith(fetchFailed(socketError(code)));
      await expect(send().sendText(text)).resolves.toEqual({ ok: false, kind: "unknown", error: `network ${code}` });
    },
  );

  it("holds an AggregateError with one post-connect failure as unknown", async () => {
    rejectWith(fetchFailed(new AggregateError([socketError("ECONNREFUSED"), socketError("ECONNRESET")])));
    await expect(send().sendText(text)).resolves.toMatchObject({ ok: false, kind: "unknown" });
  });

  it("holds an error with no code as unknown", async () => {
    rejectWith(new Error("something else"));
    await expect(send().sendText(text)).resolves.toEqual({ ok: false, kind: "unknown", error: "network Error" });
  });

  it.each([401, 403])("refuses on %i: the auth guard runs before the send", async (status) => {
    answer(status, async () => ({}));
    await expect(send().sendText(text)).resolves.toEqual({
      ok: false,
      kind: "refused",
      error: "send_refused_unauthorized",
    });
  });

  it("blocks on the instance guard's 404: the instance does not exist", async () => {
    // Evolution v2.3.7 src/api/guards/instance.guard.ts, as NotFoundException serialises it.
    answer(404, async () => ({
      status: 404,
      error: "Not Found",
      response: { message: ['The "poc" instance does not exist'] },
    }));
    await expect(send().sendText(text)).resolves.toEqual({ ok: false, kind: "disconnected", error: "evolution 404" });
  });

  // outbox-404-marks-disconnected, review of #207: a disconnected send now also
  // marks the connection DISCONNECTED, so only the instance guard's 404 may say
  // so. Express's unknown-route 404 (src/main.ts) and a proxy's 404 are held.
  it.each([
    {
      name: "Express's unknown-route 404",
      body: async () => ({ status: 404, error: "Not Found", response: { message: ["Cannot POST /message/sendText/poc"] } }),
    },
    { name: "a 404 with an empty body", body: async () => ({}) },
    {
      name: "a 404 whose body is not JSON",
      body: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    },
  ])("holds $name as unknown, not disconnected", async ({ body }) => {
    answer(404, body);
    await expect(send().sendText(text)).resolves.toEqual({
      ok: false,
      kind: "unknown",
      error: "evolution 404 not an instance answer",
    });
  });

  it("refuses a 400 saying the number is not on WhatsApp", async () => {
    answer(400, async () => ({
      status: 400,
      error: "Bad Request",
      response: { message: [{ exists: false, jid: "5511999999999@s.whatsapp.net", number: "5511999999999" }] },
    }));
    await expect(send().sendText(text)).resolves.toEqual({
      ok: false,
      kind: "refused",
      error: "send_refused_not_on_whatsapp",
    });
  });

  it("holds any other 400 as unknown: Evolution's catch-all wraps work done after the relay", async () => {
    answer(400, async () => ({
      status: 400,
      error: "Bad Request",
      response: { message: ["Error: PrismaClientKnownRequestError"] },
    }));
    await expect(send().sendText(text)).resolves.toEqual({ ok: false, kind: "unknown", error: "evolution 400" });
  });

  it("holds a 400 whose body cannot be read as unknown", async () => {
    answer(400, async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    });
    await expect(send().sendText(text)).resolves.toEqual({
      ok: false,
      kind: "unknown",
      error: "evolution 400 unreadable",
    });
  });

  it.each([500, 502, 503, 504])("holds %i as unknown", async (status) => {
    answer(status, async () => ({}));
    await expect(send().sendText(text)).resolves.toEqual({ ok: false, kind: "unknown", error: `evolution ${status}` });
  });

  it("holds a 2xx whose body cannot be read as unknown", async () => {
    answer(201, async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    });
    await expect(send().sendText(text)).resolves.toEqual({
      ok: false,
      kind: "unknown",
      error: "evolution 2xx unreadable",
    });
  });
});

describe("createEvolutionSend time limits", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("holds a text send past its limit as unknown", async () => {
    slowFetch(1_000);
    const send = createEvolutionSend({ baseUrl: "http://evo.test", apiKey: "k", textTimeoutMs: 20 });
    await expect(send.sendText(text)).resolves.toEqual({ ok: false, kind: "unknown", error: "network TimeoutError" });
  });

  it("gives media its own, longer limit", async () => {
    slowFetch(60);
    const send = createEvolutionSend({ baseUrl: "http://evo.test", apiKey: "k", textTimeoutMs: 20, mediaTimeoutMs: 1_000 });
    await expect(send.sendMedia(image)).resolves.toMatchObject({ ok: true, externalMessageId: "evo-late" });
  });

  it("applies the media limit to media too", async () => {
    slowFetch(1_000);
    const send = createEvolutionSend({ baseUrl: "http://evo.test", apiKey: "k", mediaTimeoutMs: 20 });
    await expect(send.sendWhatsAppAudio({ instanceName: "poc", number: "5511999999999", audio: "ZmFrZQ==" })).resolves.toEqual({
      ok: false,
      kind: "unknown",
      error: "network TimeoutError",
    });
  });

  it("defaults to 30 s for text and 120 s for media", async () => {
    const { EVOLUTION_TEXT_SEND_TIMEOUT_MS, EVOLUTION_MEDIA_SEND_TIMEOUT_MS } = await import("./evolution.js");
    expect([EVOLUTION_TEXT_SEND_TIMEOUT_MS, EVOLUTION_MEDIA_SEND_TIMEOUT_MS]).toEqual([30_000, 120_000]);
  });
});
