/**
 * Test design (testing-strategy)
 *
 * Moved from apps/api/src/conversations/evolution.test.ts (adopt-modular-vertical-slices
 * 4A), all cases, assertions unchanged: the api's Evolution helpers are channel's now,
 * which owns Evolution. Pure; module role: none. fetch is stubbed, never Evolution.
 *
 * Setup: vi.stubGlobal("fetch") against fetchEvolutionMedia() and
 * fetchEvolutionConnected(). No live Evolution.
 *
 * Spec: whatsapp-media-on-demand D1 — API POST getBase64FromMediaMessage,
 * decode base64, fail closed when the instance cannot supply the file.
 * hosted-evolution-channel — percent-encode instance path (space → %20).
 * fetchEvolutionConnected returns boolean (existing contract: true only
 * when HTTP ok and state is "open").
 *
 * Axes
 *   1. HTTP status — 2xx vs not ok
 *   2. body.base64 — present vs missing
 *   3. convertToMp4 — true vs false (passed through, not decided here)
 *   4. instanceName — unreserved `poc` vs space `Select Lub` vs `+` vs `/`
 *      (oracle: encodeURIComponent literals; both inlined call sites)
 *
 * Outputs: O1 ok + decoded bytes; O2 ok: false; O3 connected true; O4 false
 *
 * Decisions (media)
 *   D1 !response.ok     — 503 vs 200 (sampled)
 *   D2 missing base64   — 200 without base64 vs 200 with base64
 *   D3 fetch throws     — network error vs 200
 *   D4 convertToMp4     — true vs false in the POST body
 *
 * Decisions (fetchEvolutionConnected)
 *   C1 !response.ok          T: 503 → false; F: 200
 *   C2 state === "open"      T: instance.state open; F: "close"
 *   C3 catch                 T: throw → false; F: 200
 *   C4 instance?.state ??    left: instance.state open; right: top-level state open
 *   C5 missing SERVER_URL    T: false, fetch not called; F: options.baseUrl its
 *
 * Inlined encodeURIComponent has no `if`.
 *
 * Sampled cells (encoding; both call sites)
 *   it                         | fails if
 *   poc                        | path segment ≠ poc
 *   Select Lub → Select%20Lub  | raw space or segment ≠ Select%20Lub
 *   Select+Lub → Select%2BLub  | URL contains Select+Lub
 *   Select/Lub → Select%2FLub  | URL contains Select/Lub
 *
 * Out of scope: drain sendMedia (worker evolution.test.ts); HTTP 404 mapping
 * (conversations.media.test.ts injects a fake at the store).
 * Empty instance name — seed defaults select-lub-poc; not a panel name.
 * Names containing `%` — spec stores the unencoded panel name.
 * options/env fallbacks on baseUrl, apiKey, instanceName — process env is
 * already set (same as worker evolutionConfig). asRecord `: null` (non-object
 * JSON) and readString empty/non-string — media fail-closed already sampled
 * via missing base64; not extra its in this change.
 * C4 ?? top-level `state: "open"` is a passing it (not a header-only row).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchEvolutionConnected, fetchEvolutionMedia } from "./live-probe.js";

const instancePathCases = [
  { instanceName: "poc", encoded: "poc" }, // unreserved — encodeURIComponent unchanged
  { instanceName: "Select Lub", encoded: "Select%20Lub" }, // space
  { instanceName: "Select+Lub", encoded: "Select%2BLub" }, // plus — not a space
  { instanceName: "Select/Lub", encoded: "Select%2FLub" }, // slash — extra path segment if raw
] as const;

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })),
  );
}

describe("fetchEvolutionMedia", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes base64 and forwards convertToMp4 false", async () => {
    stubFetch(200, { base64: "aGVsbG8=", mimetype: "image/jpeg", fileName: "foto.jpg" });

    await expect(
      fetchEvolutionMedia({
        instanceName: "poc",
        externalMessageId: "ABC",
        convertToMp4: false,
        baseUrl: "http://evo.test",
        apiKey: "k",
      }),
    ).resolves.toEqual({
      ok: true,
      bytes: Buffer.from("hello"),
      mimeType: "image/jpeg",
      fileName: "foto.jpg",
    });
    expect(JSON.parse(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body))).toEqual({
      message: { key: { id: "ABC" } },
      convertToMp4: false,
    });
  });

  it("forwards convertToMp4 true and fails without base64", async () => {
    stubFetch(200, { base64: "dmlkZWE=", mimetype: "video/mp4" });
    await fetchEvolutionMedia({
      instanceName: "poc",
      externalMessageId: "VID",
      convertToMp4: true,
      baseUrl: "http://evo.test",
      apiKey: "k",
    });
    expect(JSON.parse(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body))).toMatchObject({
      convertToMp4: true,
    });

    stubFetch(200, { mimetype: "image/jpeg" });
    await expect(
      fetchEvolutionMedia({
        instanceName: "poc",
        externalMessageId: "ABC",
        convertToMp4: false,
        baseUrl: "http://evo.test",
        apiKey: "k",
      }),
    ).resolves.toEqual({ ok: false });
  });

  it("returns ok false when Evolution is not ok or fetch throws", async () => {
    stubFetch(503, {});
    await expect(
      fetchEvolutionMedia({
        instanceName: "poc",
        externalMessageId: "ABC",
        convertToMp4: false,
        baseUrl: "http://evo.test",
        apiKey: "k",
      }),
    ).resolves.toEqual({ ok: false });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    await expect(
      fetchEvolutionMedia({
        instanceName: "poc",
        externalMessageId: "ABC",
        convertToMp4: false,
        baseUrl: "http://evo.test",
        apiKey: "k",
      }),
    ).resolves.toEqual({ ok: false });
  });

  it.each(instancePathCases)(
    "percent-encodes getBase64 instanceName $instanceName",
    async ({ instanceName, encoded }) => {
      stubFetch(200, { base64: "aGVsbG8=" });

      await fetchEvolutionMedia({
        instanceName,
        externalMessageId: "ABC",
        convertToMp4: false,
        baseUrl: "http://evo.test",
        apiKey: "k",
      });

      const url = String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      expect(url).toBe(`http://evo.test/chat/getBase64FromMediaMessage/${encoded}`);
      expect(url).not.toMatch(/ /);
      if (instanceName !== encoded) {
        expect(url).not.toContain(instanceName);
      }
    },
  );
});

describe("fetchEvolutionConnected", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(instancePathCases)(
    "percent-encodes connectionState instanceName $instanceName",
    async ({ instanceName, encoded }) => {
      stubFetch(200, { instance: { state: "open" } });

      await expect(
        fetchEvolutionConnected({
          baseUrl: "http://evo.test",
          apiKey: "k",
          instanceName,
        }),
      ).resolves.toBe(true);

      const url = String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      expect(url).toBe(`http://evo.test/instance/connectionState/${encoded}`);
      expect(url).not.toMatch(/ /);
      if (instanceName !== encoded) {
        expect(url).not.toContain(instanceName);
      }
    },
  );

  it("returns false when connectionState is not ok", async () => {
    stubFetch(503, {});

    await expect(
      fetchEvolutionConnected({
        baseUrl: "http://evo.test",
        apiKey: "k",
        instanceName: "poc",
      }),
    ).resolves.toBe(false);
  });

  it("returns false when instance state is not open", async () => {
    stubFetch(200, { instance: { state: "close" } });

    await expect(
      fetchEvolutionConnected({
        baseUrl: "http://evo.test",
        apiKey: "k",
        instanceName: "poc",
      }),
    ).resolves.toBe(false);
  });

  it("returns false when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );

    await expect(
      fetchEvolutionConnected({
        baseUrl: "http://evo.test",
        apiKey: "k",
        instanceName: "poc",
      }),
    ).resolves.toBe(false);
  });

  it("returns true when top-level state is open and instance.state is missing", async () => {
    stubFetch(200, { state: "open" });

    await expect(
      fetchEvolutionConnected({
        baseUrl: "http://evo.test",
        apiKey: "k",
        instanceName: "poc",
      }),
    ).resolves.toBe(true);
  });

  it("returns false when SERVER_URL is unset, without calling fetch", async () => {
    vi.stubEnv("SERVER_URL", "");
    vi.stubEnv("AUTHENTICATION_API_KEY", "k");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchEvolutionConnected()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
