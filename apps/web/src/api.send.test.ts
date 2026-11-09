/**
 * Test design (testing-strategy)
 *
 * Setup: sendText / sendMedia against MSW.
 *
 * Oracle: scheduled-messages task 2.4 — api.ts forwards optional
 *   idempotencyKey on send-text JSON and send-media multipart.
 *
 * Axes
 *   A1 idempotencyKey — present / omitted
 *   A2 method — sendText / sendMedia
 *
 * Outputs
 *   O1 body/form includes the key; O2 body omits the key
 *
 * Sampled-cell
 *   sendText with key     | A1 on  A2 text  | O1 | omitted
 *   sendText omitted      | A1 off A2 text  | O2 | present
 *   sendMedia with key    | A1 on  A2 media | O1 | omitted
 *   sendMedia omitted     | A1 off A2 media | O2 | present
 *   sendMedia caption     | caption on/off  | form has/omits caption | inverted
 *   fetchMessageMedia 502 | !ok             | throws | resolves
 *
 * Decision map (api/send.ts)
 *   idempotencyKey truthy  T with-key its; F omitted its
 *   caption truthy         T caption it; F omitted it
 *   fetchMessageMedia !ok  T 502 it; F 200 it (App.test image GET)
 *
 * Out of scope: ConversasPage UUID generation (App.test.tsx).
 */
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { sendMedia, sendText, fetchMessageMedia } from "./api.js";
import { server } from "../test/msw/server.js";

const queued = {
  id: "out-1",
  direction: "outbound" as const,
  messageType: "text" as const,
  textBody: "oi",
  providerTimestamp: "2026-08-26T12:01:00.000Z",
  outboxStatus: "queued" as const,
};

afterEach(() => {
  server.resetHandlers();
});

describe("send API client", () => {
  it("forwards idempotencyKey on sendText", async () => {
    let body: { text?: string; idempotencyKey?: string } = {};
    server.use(
      http.post("*/api/conversations/:id/messages", async ({ request }) => {
        body = (await request.json()) as { text?: string; idempotencyKey?: string };
        return HttpResponse.json(queued, { status: 201 });
      }),
    );

    await sendText("conv-1", "oi", "key-1");

    expect(body).toEqual({ text: "oi", idempotencyKey: "key-1" });
  });

  it("omits idempotencyKey on sendText when not passed", async () => {
    let body: { text?: string; idempotencyKey?: string } = {};
    server.use(
      http.post("*/api/conversations/:id/messages", async ({ request }) => {
        body = (await request.json()) as { text?: string; idempotencyKey?: string };
        return HttpResponse.json(queued, { status: 201 });
      }),
    );

    await sendText("conv-1", "oi");

    expect(body).toEqual({ text: "oi" });
    expect(body).not.toHaveProperty("idempotencyKey");
  });

  it("forwards idempotencyKey on sendMedia", async () => {
    const keys: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body;
      if (form instanceof FormData) {
        const key = form.get("idempotencyKey");
        if (typeof key === "string") {
          keys.push(key);
        }
      }
      return new Response(JSON.stringify({ ...queued, messageType: "image", textBody: null }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await sendMedia(
        "conv-1",
        {
          file: new File([new Uint8Array([1, 2, 3])], "foto.jpg", { type: "image/jpeg" }),
          messageType: "image",
        },
        "media-key-1",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(keys).toEqual(["media-key-1"]);
  });

  it("omits idempotencyKey on sendMedia when not passed", async () => {
    const keys: Array<string | null> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body;
      if (form instanceof FormData) {
        keys.push(form.get("idempotencyKey") as string | null);
      }
      return new Response(JSON.stringify({ ...queued, messageType: "image", textBody: null }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await sendMedia("conv-1", {
        file: new File([new Uint8Array([1, 2, 3])], "foto.jpg", { type: "image/jpeg" }),
        messageType: "image",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(keys).toEqual([null]);
  });

  it("appends caption on sendMedia only when it is non-empty", async () => {
    const captions: Array<string | null> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body;
      if (form instanceof FormData) {
        captions.push(form.get("caption") as string | null);
      }
      return new Response(JSON.stringify({ ...queued, messageType: "image", textBody: null }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await sendMedia("conv-1", {
        file: new File([new Uint8Array([1])], "foto.jpg", { type: "image/jpeg" }),
        messageType: "image",
        caption: "legenda",
      });
      await sendMedia("conv-1", {
        file: new File([new Uint8Array([1])], "foto.jpg", { type: "image/jpeg" }),
        messageType: "image",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captions).toEqual(["legenda", null]);
  });

  it("throws when fetchMessageMedia is not ok", async () => {
    server.use(
      http.get("*/api/conversations/:id/messages/:messageId/media", () =>
        HttpResponse.json({ code: "media_unavailable" }, { status: 502 }),
      ),
    );

    await expect(fetchMessageMedia("conv-1", "m-1")).rejects.toThrow("http 502");
  });
});
