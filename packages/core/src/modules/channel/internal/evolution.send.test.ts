/**
 * Test design (testing-strategy)
 *
 * SUT: `createEvolutionSend` — sendText, sendWhatsAppAudio, sendMedia and
 *   getBase64FromMediaMessage — with `vi.stubGlobal("fetch")` restored after
 *   each case. No live Evolution.
 *
 * Split out of evolution.test.ts (same folder) when the move to
 * `packages/core` put that file past the 300-line limit; its full test-design
 * header — spec, axes, the encoding sampled cells and what is out of scope —
 * covers this file too. Module role: none — no database, every request goes to a
 * stubbed `fetch`, never to Evolution.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvolutionSend } from "./evolution.js";

const instancePathCases = [
  { instanceName: "poc", encoded: "poc" }, // unreserved — encodeURIComponent unchanged
  { instanceName: "Select Lub", encoded: "Select%20Lub" }, // space
] as const;

const sendTextPathCases = [
  ...instancePathCases,
  { instanceName: "Select+Lub", encoded: "Select%2BLub" }, // plus — not a space
  { instanceName: "Select/Lub", encoded: "Select%2FLub" }, // slash — extra path segment if raw
] as const;

describe("createEvolutionSend", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("returns the provider id when Evolution accepts the send", async () => {
    stubFetch(200, { key: { id: "evo-1" } });
    const send = createEvolutionSend({ baseUrl: "http://evo.test/", apiKey: "k" });

    await expect(
      send.sendText({ instanceName: "poc", number: "5511999999999", text: "oi" }),
    ).resolves.toEqual({ ok: true, externalMessageId: "evo-1", providerTimestamp: null });
    expect(fetch).toHaveBeenCalledWith(
      "http://evo.test/message/sendText/poc",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each(sendTextPathCases)(
    "percent-encodes sendText instanceName $instanceName",
    async ({ instanceName, encoded }) => {
      stubFetch(200, { key: { id: "evo-1" } });
      const send = createEvolutionSend({ baseUrl: "http://evo.test/", apiKey: "k" });

      await send.sendText({ instanceName, number: "5511999999999", text: "oi" });

      const url = String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
      expect(url).toBe(`http://evo.test/message/sendText/${encoded}`);
      expect(url).not.toMatch(/ /);
      if (instanceName !== encoded) {
        expect(url).not.toContain(instanceName);
      }
    },
  );

  it.each([
    {
      name: "201 numeric seconds (sampled live)",
      status: 201,
      messageTimestamp: 1735689600,
      expected: new Date(1735689600 * 1000),
    },
    {
      name: "200 numeric seconds",
      status: 200,
      messageTimestamp: 1735689600,
      expected: new Date(1735689600 * 1000),
    },
    {
      name: "numeric string seconds",
      status: 200,
      messageTimestamp: "1735689600",
      expected: new Date(1735689600 * 1000),
    },
    { name: "missing", status: 200, messageTimestamp: undefined, expected: null },
    { name: "null", status: 200, messageTimestamp: null, expected: null },
    { name: "non-numeric string", status: 200, messageTimestamp: "not-a-number", expected: null },
    {
      name: "protobuf-shaped { low, high }",
      status: 200,
      messageTimestamp: { low: 1735689600, high: 0, unsigned: true },
      expected: null,
    },
  ])("maps root messageTimestamp ($name) to providerTimestamp", async ({ status, messageTimestamp, expected }) => {
    stubFetch(status, { key: { id: "evo-1" }, messageTimestamp });
    const send = createEvolutionSend({ baseUrl: "http://evo.test/", apiKey: "k" });

    await expect(
      send.sendText({ instanceName: "poc", number: "5511999999999", text: "oi" }),
    ).resolves.toEqual({ ok: true, externalMessageId: "evo-1", providerTimestamp: expected });
  });

  it.each([
    { name: "nested numeric mediaKeyTimestamp", mediaKeyTimestamp: 1735689600 },
    {
      name: "nested protobuf mediaKeyTimestamp",
      mediaKeyTimestamp: { low: 1735689600, high: 0, unsigned: true },
    },
  ])("ignores a nested $name when the root messageTimestamp is missing", async ({ mediaKeyTimestamp }) => {
    stubFetch(200, {
      key: { id: "evo-1" },
      message: { imageMessage: { mediaKeyTimestamp } },
    });
    const send = createEvolutionSend({ baseUrl: "http://evo.test/", apiKey: "k" });

    await expect(
      send.sendText({ instanceName: "poc", number: "5511999999999", text: "oi" }),
    ).resolves.toEqual({ ok: true, externalMessageId: "evo-1", providerTimestamp: null });
  });

  // What each status proves about delivery (hold-unknown-outcome-sends, D2): a 400
  // or any 5xx may follow the relay. A 404 depends on its body (the instance guard
  // blocks, anything else is unknown), so it is sampled with bodies in
  // evolution.send-outcome.test.ts, beside the thrown errors and the time limit.
  it.each([
    { status: 400, kind: "unknown" },
    { status: 503, kind: "unknown" },
    { status: 500, kind: "unknown" },
  ])("maps HTTP $status to kind=$kind", async ({ status, kind }) => {
    stubFetch(status, {});
    const send = createEvolutionSend({ baseUrl: "http://evo.test", apiKey: "k" });

    await expect(
      send.sendText({ instanceName: "poc", number: "5511999999999", text: "oi" }),
    ).resolves.toEqual({
      ok: false,
      kind,
      error: `evolution ${status}`,
    });
  });

  it("fails when a 200 response omits the provider message id", async () => {
    stubFetch(200, { key: {} });
    const send = createEvolutionSend({ baseUrl: "http://evo.test", apiKey: "k" });

    await expect(
      send.sendText({ instanceName: "poc", number: "5511999999999", text: "oi" }),
    ).resolves.toEqual({ ok: false, kind: "unknown", error: "missing provider id" });
  });

  it("still fails for a missing provider id when the body has a root timestamp", async () => {
    stubFetch(200, { key: {}, messageTimestamp: 1735689600 });
    const send = createEvolutionSend({ baseUrl: "http://evo.test", apiKey: "k" });

    await expect(
      send.sendText({ instanceName: "poc", number: "5511999999999", text: "oi" }),
    ).resolves.toEqual({ ok: false, kind: "unknown", error: "missing provider id" });
  });

  it("returns the provider id when Evolution accepts sendMedia", async () => {
    stubFetch(200, { key: { id: "evo-img" } });
    const send = createEvolutionSend({ baseUrl: "http://evo.test", apiKey: "k" });

    await expect(
      send.sendMedia({
        instanceName: "poc",
        number: "5511999999999",
        mediatype: "image",
        media: "ZmFrZQ==",
        mimetype: "image/jpeg",
        fileName: "foto.jpg",
        caption: "frente",
      }),
    ).resolves.toEqual({ ok: true, externalMessageId: "evo-img", providerTimestamp: null });
    expect(fetch).toHaveBeenCalledWith(
      "http://evo.test/message/sendMedia/poc",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body))).toEqual({
      number: "5511999999999",
      mediatype: "image",
      media: "ZmFrZQ==",
      mimetype: "image/jpeg",
      fileName: "foto.jpg",
      caption: "frente",
    });
  });

  it("maps a 400 sendMedia answer and a 200 without id to unknown", async () => {
    stubFetch(400, {});
    const send = createEvolutionSend({ baseUrl: "http://evo.test", apiKey: "k" });
    await expect(
      send.sendMedia({
        instanceName: "poc",
        number: "5511999999999",
        mediatype: "image",
        media: "ZmFrZQ==",
      }),
    ).resolves.toEqual({ ok: false, kind: "unknown", error: "evolution 400" });

    stubFetch(200, { key: {} });
    const again = createEvolutionSend({ baseUrl: "http://evo.test", apiKey: "k" });
    await expect(
      again.sendMedia({
        instanceName: "poc",
        number: "5511999999999",
        mediatype: "document",
        media: "ZmFrZQ==",
        fileName: "a.pdf",
      }),
    ).resolves.toEqual({ ok: false, kind: "unknown", error: "missing provider id" });
  });

  it("returns the provider id when Evolution accepts sendWhatsAppAudio", async () => {
    stubFetch(200, { key: { id: "evo-aud" } });
    const send = createEvolutionSend({ baseUrl: "http://evo.test", apiKey: "k" });

    await expect(
      send.sendWhatsAppAudio({ instanceName: "poc", number: "5511999999999", audio: "ZmFrZQ==" }),
    ).resolves.toEqual({ ok: true, externalMessageId: "evo-aud", providerTimestamp: null });
    expect(fetch).toHaveBeenCalledWith(
      "http://evo.test/message/sendWhatsAppAudio/poc",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns base64 when getBase64FromMediaMessage succeeds", async () => {
    stubFetch(200, { base64: "ZmFrZQ==", mimetype: "image/jpeg", fileName: "foto.jpg" });
    const send = createEvolutionSend({ baseUrl: "http://evo.test", apiKey: "k" });

    await expect(
      send.getBase64FromMediaMessage({
        instanceName: "poc",
        externalMessageId: "ABC",
        convertToMp4: false,
      }),
    ).resolves.toEqual({
      ok: true,
      base64: "ZmFrZQ==",
      mimetype: "image/jpeg",
      fileName: "foto.jpg",
    });
    expect(JSON.parse(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body))).toEqual({
      message: { key: { id: "ABC" } },
      convertToMp4: false,
    });
  });

  it.each(instancePathCases)(
    "percent-encodes getBase64 instanceName $instanceName",
    async ({ instanceName, encoded }) => {
      stubFetch(200, { base64: "ZmFrZQ==" });
      const send = createEvolutionSend({ baseUrl: "http://evo.test", apiKey: "k" });

      await send.getBase64FromMediaMessage({
        instanceName,
        externalMessageId: "ABC",
        convertToMp4: false,
      });

      expect(fetch).toHaveBeenCalledWith(
        `http://evo.test/chat/getBase64FromMediaMessage/${encoded}`,
        expect.objectContaining({ method: "POST" }),
      );
      expect(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).not.toMatch(/ /);
    },
  );

  it("sets convertToMp4 true for a video fetch and fails without base64", async () => {
    stubFetch(200, { base64: "dmlkZWE=", mimetype: "video/mp4" });
    const send = createEvolutionSend({ baseUrl: "http://evo.test", apiKey: "k" });
    await send.getBase64FromMediaMessage({
      instanceName: "poc",
      externalMessageId: "VID",
      convertToMp4: true,
    });
    expect(JSON.parse(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body))).toMatchObject({
      convertToMp4: true,
    });

    stubFetch(200, { mimetype: "image/jpeg" });
    const again = createEvolutionSend({ baseUrl: "http://evo.test", apiKey: "k" });
    await expect(
      again.getBase64FromMediaMessage({
        instanceName: "poc",
        externalMessageId: "ABC",
        convertToMp4: false,
      }),
    ).resolves.toEqual({ ok: false, disconnected: false, error: "missing media" });
  });

  it("maps getBase64 disconnect-class HTTP status", async () => {
    stubFetch(503, {});
    const send = createEvolutionSend({ baseUrl: "http://evo.test", apiKey: "k" });
    await expect(
      send.getBase64FromMediaMessage({
        instanceName: "poc",
        externalMessageId: "ABC",
        convertToMp4: false,
      }),
    ).resolves.toEqual({ ok: false, disconnected: true, error: "evolution 503" });
  });
});
