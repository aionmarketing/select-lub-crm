/**
 * Test design (testing-strategy)
 *
 * Moved from apps/worker/src/outbox/evolution.test.ts (wave 3, stream 3A-channel),
 * beside the adapter it tests: a slice's tests may not reach `internal/`, and this
 * file is pure, as wave 2B's `internal/` tests are. Module role: none — it touches
 * no database, and every request goes to a stubbed `fetch`, never to Evolution.
 *
 * Setup: createEvolutionHistory with an injected fetch; createEvolutionSend
 * with vi.stubGlobal("fetch") restored after that describe. No live Evolution.
 * The createEvolutionSend describe lives in evolution.send.test.ts, split off
 * for the 300-line limit; this header covers both files.
 *
 * Spec: whatsapp-history-backfill / PEND-CH-07 (findChats / findMessages);
 * whatsapp-channel outbox (sendText ok vs disconnect vs missing provider id);
 * outbox-send-provider-timestamp (root messageTimestamp only);
 * whatsapp-media-on-demand (sendWhatsAppAudio, sendMedia, getBase64).
 *
 * Axes (history)
 *   1. HTTP status — 2xx vs not ok
 *   2. findMessages page — currentPage < pages vs last/empty
 *   3. record count vs HISTORY_PAGE_SIZE when pages is omitted
 *   4. findChats body — array vs { chats } vs id-as-jid vs uuid without @
 *
 * Axes (sendText / sendMedia / sendWhatsAppAudio share postSend)
 *   5. HTTP status — 2xx (200 and sampled live 201) vs 400/404/503 vs other not-ok
 *   6. body.key.id — present vs missing (missing stays fail even when timestamp present)
 *   9. env — SERVER_URL / AUTHENTICATION_API_KEY missing when options omit them
 *      (throws; worker boot uses createEvolutionSend() with no options)
 *   6b. root body.messageTimestamp — numeric seconds vs numeric string vs
 *       missing vs null vs non-numeric vs { low, high }
 *       Nested media timestamps (number or { low, high }) are a separate
 *       invalid class: they MUST NOT become providerTimestamp.
 *   BVA seconds/ms cutoff (1e12) lives in core's conversations-parse.test.ts D16; postSend
 *       only forwards the root field to that parser — not re-sampled here.
 *
 * Axes (getBase64)
 *   7. HTTP status — 2xx vs disconnect-class vs other not-ok
 *   8. body.base64 — present vs missing
 *   9. convertToMp4 — true (video) vs false
 *
 * Outputs: O1 chats with remoteJid; O2 { records, hasMore }; O3 throw evolution N;
 *   O4 send ok + id + providerTimestamp; O5 send fail disconnected; O6 send fail missing id;
 *   O7 getBase64 ok; O8 getBase64 missing media.
 *
 * Decisions (history)
 *   D1 response.ok false          — 500 vs 200
 *   D2 records.length === 0       — empty page vs records present
 *   D3 pages+currentPage present  — currentPage < pages vs last page
 *   D4 fallback length >= 50      — 50 vs 49 (pages omitted)
 *   D5 body is array              — findChats array vs { chats }
 *   D6 remoteJid vs id with @     — named field vs jid id vs uuid id skipped
 *
 * Decisions (sendText)
 *   S1 !response.ok               — 400/404/503 vs 500 vs 200/201
 *   S2 disconnected               — 400/404/503 T; 500 F
 *   S3 missing key.id             — 200 without id vs 200 with id; 200 with
 *       timestamp but no id (no timestamp shortcut)
 *   S4 parseTimestamp(root)       — number/string seconds vs missing/null/
 *       non-numeric/{ low, high }; nested-only timestamps (S4 false)
 *
 * Sampled cells (postSend timestamp; oracle: outbox-send-provider-timestamp)
 *   it                                         | fails if
 *   201 numeric seconds (sampled live)         | providerTimestamp ≠ that Date
 *   200 numeric seconds                        | providerTimestamp ≠ that Date
 *   numeric string seconds                     | providerTimestamp ≠ that Date
 *   missing / null / non-numeric / {low,high}  | providerTimestamp ≠ null
 *   nested media timestamp only                | providerTimestamp is a Date
 *   200 no key.id + root timestamp             | ok:true (must stay missing id)
 *
 * Decisions (media helpers; same postSend as sendText except path/body)
 *   M1 sendMedia 200 + key.id     — sampled
 *   M2 sendMedia 200 missing id   — sampled
 *   M3 sendMedia disconnect-class — 400 sampled (404/503 same as S2)
 *   M4 sendWhatsAppAudio 200 + id — sampled
 *   G1 getBase64 200 + base64     — sampled
 *   G2 getBase64 200 no base64    — sampled
 *   G3 getBase64 503 disconnected — sampled
 *   G4 convertToMp4 true vs false — both sampled
 *
 * Axes (hosted-evolution-channel path encoding; oracle: encodeURIComponent
 *   literals — space `%20`, plus `%2B`, slash `%2F`)
 *   10. instanceName — unreserved `poc` vs space `Select Lub` vs `+` vs `/`
 *   sendText samples all four. findChats / getConnectionState / getBase64
 *   sample poc + space only; sendMedia / sendWhatsAppAudio / findMessages
 *   share instancePathSegment — not re-sampled.
 *   instancePathSegment has no `if` (encodeURIComponent only).
 *
 * Sampled cells (encoding; sendText)
 *   it                         | fails if
 *   poc                        | path ≠ /sendText/poc
 *   Select Lub → Select%20Lub  | raw space in URL or path ≠ Select%20Lub
 *   Select+Lub → Select%2BLub  | URL contains Select+Lub
 *   Select/Lub → Select%2FLub  | URL contains Select/Lub
 *
 * Out of scope: live Evolution v2.3.7; drain stubs EvolutionSend (drain.test.ts).
 *   chatRemoteJid non-object row (lines 35-37); findChats body that is neither
 *   an array nor `{ chats: array }` (empty list, line 67). Coverage finder
 *   (this change) left those lines uncovered on purpose — older history map,
 *   not encoding. Empty instance name — seed defaults select-lub-poc; not a
 *   panel name. Names containing `%` — spec stores the unencoded panel name.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEvolutionConnectionState,
  createEvolutionHistory,
  createEvolutionSend,
  EVOLUTION_CONNECTION_STATE_TIMEOUT_MS,
  HISTORY_PAGE_SIZE,
} from "./evolution.js";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function historyFetch(
  handler: (url: string, body: unknown) => ReturnType<typeof jsonResponse>,
) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return handler(url, body);
  });
}

const fifty = Array.from({ length: HISTORY_PAGE_SIZE }, (_, index) => ({ id: `m${index}` }));

const instancePathCases = [
  { instanceName: "poc", encoded: "poc" }, // unreserved — encodeURIComponent unchanged
  { instanceName: "Select Lub", encoded: "Select%20Lub" }, // space
] as const;

describe("createEvolutionHistory", () => {
  it("pages findMessages until hasMore is false after two full pages", async () => {
    const fetchImpl = historyFetch((url, body) => {
      expect(url).toBe("http://evo.test/chat/findMessages/select-lub-poc");
      const page = (body as { page: number }).page;
      if (page === 1) {
        return jsonResponse({
          messages: { total: 100, pages: 2, currentPage: 1, records: fifty },
        });
      }
      if (page === 2) {
        return jsonResponse({
          messages: { total: 100, pages: 2, currentPage: 2, records: fifty },
        });
      }
      return jsonResponse({ messages: { total: 100, pages: 2, currentPage: 3, records: [] } });
    });
    const client = createEvolutionHistory({
      baseUrl: "http://evo.test",
      apiKey: "secret-key",
      fetchImpl,
    });

    const first = await client.findMessagesPage("select-lub-poc", "5511999999999@s.whatsapp.net", 1);
    const second = await client.findMessagesPage("select-lub-poc", "5511999999999@s.whatsapp.net", 2);

    expect(first.records).toHaveLength(HISTORY_PAGE_SIZE);
    expect(first.hasMore).toBe(true);
    expect(second.records).toHaveLength(HISTORY_PAGE_SIZE);
    expect(second.hasMore).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstInit = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(firstInit.headers).toMatchObject({ apikey: "secret-key" });
    expect(JSON.parse(String(firstInit.body))).toEqual({
      where: { key: { remoteJid: "5511999999999@s.whatsapp.net" } },
      page: 1,
      offset: HISTORY_PAGE_SIZE,
    });
  });

  it("stops when a page has fewer than 50 records and pages is omitted", async () => {
    const fetchImpl = historyFetch(() =>
      jsonResponse({ messages: { records: fifty.slice(0, 49) } }),
    );
    const client = createEvolutionHistory({ baseUrl: "http://evo.test", apiKey: "k", fetchImpl });

    const page = await client.findMessagesPage("poc", "jid@s.whatsapp.net", 1);

    expect(page.records).toHaveLength(49);
    expect(page.hasMore).toBe(false);
  });

  it("treats a 50-record page as hasMore when pages is omitted", async () => {
    const fetchImpl = historyFetch(() => jsonResponse({ messages: { records: fifty } }));
    const client = createEvolutionHistory({ baseUrl: "http://evo.test", apiKey: "k", fetchImpl });

    expect((await client.findMessagesPage("poc", "jid@s.whatsapp.net", 1)).hasMore).toBe(true);
  });

  it("treats an empty records page as hasMore false", async () => {
    const fetchImpl = historyFetch(() => jsonResponse({ messages: { records: [] } }));
    const client = createEvolutionHistory({ baseUrl: "http://evo.test", apiKey: "k", fetchImpl });

    const page = await client.findMessagesPage("poc", "jid@s.whatsapp.net", 1);

    expect(page.records).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it("lists findChats remotes from an array and a chats wrapper", async () => {
    const fetchImpl = historyFetch((url) => {
      expect(url).toBe("http://evo.test/chat/findChats/poc");
      return jsonResponse([
        { remoteJid: "5511999999999@s.whatsapp.net" },
        { id: "5511888888888@s.whatsapp.net" },
        { id: "not-a-jid-uuid" },
      ]);
    });
    const client = createEvolutionHistory({ baseUrl: "http://evo.test", apiKey: "k", fetchImpl });

    await expect(client.findChats("poc")).resolves.toEqual([
      { remoteJid: "5511999999999@s.whatsapp.net" },
      { remoteJid: "5511888888888@s.whatsapp.net" },
    ]);

    const wrapped = createEvolutionHistory({
      baseUrl: "http://evo.test",
      apiKey: "k",
      fetchImpl: historyFetch(() =>
        jsonResponse({ chats: [{ remoteJid: "5511777777777@s.whatsapp.net" }] }),
      ),
    });
    await expect(wrapped.findChats("poc")).resolves.toEqual([
      { remoteJid: "5511777777777@s.whatsapp.net" },
    ]);
  });

  it.each(instancePathCases)(
    "percent-encodes findChats instanceName $instanceName",
    async ({ instanceName, encoded }) => {
      const fetchImpl = historyFetch((url) => {
        expect(url).toBe(`http://evo.test/chat/findChats/${encoded}`);
        expect(url).not.toMatch(/ /);
        return jsonResponse([]);
      });
      const client = createEvolutionHistory({ baseUrl: "http://evo.test", apiKey: "k", fetchImpl });

      await client.findChats(instanceName);
    },
  );

  it("throws when Evolution returns a non-ok status", async () => {
    const client = createEvolutionHistory({
      baseUrl: "http://evo.test",
      apiKey: "k",
      fetchImpl: historyFetch(() => jsonResponse({ error: "no" }, 500)),
    });

    await expect(client.findChats("poc")).rejects.toThrow("evolution 500");
  });
});

describe("createEvolutionConnectionState", () => {
  it.each([
    { name: "instance.state open", body: { instance: { state: "open" } }, expected: "CONNECTED" },
    { name: "top-level connecting", body: { state: "connecting" }, expected: "CONNECTING" },
    { name: "instance.state close", body: { instance: { state: "close" } }, expected: "DISCONNECTED" },
  ] as const)("maps $name to $expected", async ({ body, expected }) => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://evo.test/instance/connectionState/poc");
      expect(init?.method).toBeUndefined();
      expect(init?.headers).toEqual({ apikey: "k" });
      return jsonResponse(body);
    });
    const client = createEvolutionConnectionState({
      baseUrl: "http://evo.test",
      apiKey: "k",
      fetchImpl,
    });

    await expect(client.getConnectionState("poc")).resolves.toEqual({
      ok: true,
      evolutionState: expected,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(instancePathCases)(
    "percent-encodes connectionState instanceName $instanceName",
    async ({ instanceName, encoded }) => {
      const fetchImpl = vi.fn(async (url: string) => {
        expect(url).toBe(`http://evo.test/instance/connectionState/${encoded}`);
        expect(url).not.toMatch(/ /);
        return jsonResponse({ instance: { state: "open" } });
      });
      const client = createEvolutionConnectionState({
        baseUrl: "http://evo.test",
        apiKey: "k",
        fetchImpl,
      });

      await client.getConnectionState(instanceName);
    },
  );

  it("maps the instance guard's 404, the instance does not exist, to DISCONNECTED", async () => {
    // outbox-404-marks-disconnected: that 404 is a fact about the session, not a
    // failed lookup. As `{ ok: false }` it left a missing instance CONNECTED.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ status: 404, error: "Not Found", response: { message: ['The "poc" instance does not exist'] } }, 404),
    );
    const client = createEvolutionConnectionState({
      baseUrl: "http://evo.test",
      apiKey: "k",
      fetchImpl,
    });

    await expect(client.getConnectionState("poc")).resolves.toEqual({ ok: true, evolutionState: "DISCONNECTED" });
  });

  // Review of #207: only the instance guard's 404 may flip a connection. An
  // unknown route (Express's fallback in Evolution's src/main.ts) or a proxy's
  // bare 404 is a failed lookup and leaves the stored state alone.
  it.each([
    { name: "Express's unknown-route 404", body: { status: 404, error: "Not Found", response: { message: ["Cannot GET /instance/connectionState/poc"] } } },
    { name: "a bare 404", body: { status: 404, error: "Not Found" } },
  ])("returns ok false on $name", async ({ body }) => {
    const fetchImpl = vi.fn(async () => jsonResponse(body, 404));
    const client = createEvolutionConnectionState({
      baseUrl: "http://evo.test",
      apiKey: "k",
      fetchImpl,
    });

    await expect(client.getConnectionState("poc")).resolves.toEqual({ ok: false });
  });

  it("returns ok false on HTTP 500", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500));
    const client = createEvolutionConnectionState({
      baseUrl: "http://evo.test",
      apiKey: "k",
      fetchImpl,
    });

    await expect(client.getConnectionState("poc")).resolves.toEqual({ ok: false });
  });

  it("returns ok false when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network");
    });
    const client = createEvolutionConnectionState({
      baseUrl: "http://evo.test",
      apiKey: "k",
      fetchImpl,
    });

    await expect(client.getConnectionState("poc")).resolves.toEqual({ ok: false });
  });

  it("returns ok false when state is missing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ instance: {} }));
    const client = createEvolutionConnectionState({
      baseUrl: "http://evo.test",
      apiKey: "k",
      fetchImpl,
    });

    await expect(client.getConnectionState("poc")).resolves.toEqual({ ok: false });
  });

  it("returns ok false when state is unrecognized", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ instance: { state: "refuting" } }));
    const client = createEvolutionConnectionState({
      baseUrl: "http://evo.test",
      apiKey: "k",
      fetchImpl,
    });

    await expect(client.getConnectionState("poc")).resolves.toEqual({ ok: false });
  });

  it("gives up on a lookup that never answers, within its bound, as ok false", async () => {
    // A server that never responds: the only way this promise settles is the
    // abort, rejecting as real fetch does. Without the bound, a heartbeat's
    // reconcile would hang here and hold the whole heartbeat job with it.
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const client = createEvolutionConnectionState({
      baseUrl: "http://evo.test",
      apiKey: "k",
      fetchImpl,
      timeoutMs: 50,
    });

    const started = Date.now();
    await expect(client.getConnectionState("poc")).resolves.toEqual({ ok: false });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("bounds every lookup by default, at a limit well under the 30 s heartbeat", async () => {
    let signal: AbortSignal | null | undefined;
    const client = createEvolutionConnectionState({
      baseUrl: "http://evo.test",
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        signal = init?.signal;
        return jsonResponse({ state: "open" });
      },
    });

    await client.getConnectionState("poc");

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    expect(EVOLUTION_CONNECTION_STATE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(EVOLUTION_CONNECTION_STATE_TIMEOUT_MS).toBeLessThan(30_000);
  });
});

describe("evolutionConfig via createEvolutionSend", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when SERVER_URL is unset and no baseUrl is passed", () => {
    vi.stubEnv("SERVER_URL", "");
    vi.stubEnv("AUTHENTICATION_API_KEY", "k");
    expect(() => createEvolutionSend()).toThrow(/SERVER_URL/);
  });

  it("throws when AUTHENTICATION_API_KEY is unset and no apiKey is passed", () => {
    vi.stubEnv("SERVER_URL", "http://evo.test");
    vi.stubEnv("AUTHENTICATION_API_KEY", "");
    expect(() => createEvolutionSend()).toThrow(/AUTHENTICATION_API_KEY/);
  });
});
