/**
 * Test design (testing-strategy) — the guard's raw exchange, over a real socket
 *
 * SUT: createNodeRequest, given `http.request` so it can talk to a local server (the guard
 *   itself refuses loopback, so it is not in the path here; this is only the reading loop).
 *
 * Oracle: second review of #180 (2026-09-25, LOW): the body is read up to `maxBytes` and cut
 *   there, however the server chunks it; a redirect's body is never read — the socket is dropped
 *   at the status line, even when the server would stream forever; a connection that closes
 *   before the body ends is an error, not a short body.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeRequest, type RequestFn } from "./guarded-http.js";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/big") {
      // 100 KB in 1 KB chunks.
      res.writeHead(200, { "content-type": "application/pdf" });
      const chunk = Buffer.alloc(1024, 0x41);
      for (let i = 0; i < 100; i += 1) res.write(chunk);
      res.end();
    } else if (req.url === "/small") {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end("%PDF-1.4 tiny");
    } else if (req.url === "/redirect-forever") {
      // A redirect whose body never ends: reading it would hang the request.
      res.writeHead(302, { location: "https://www.vw.com.br/a.pdf" });
      const tick = setInterval(() => res.write("x".repeat(1024)), 5);
      res.on("close", () => clearInterval(tick));
    } else if (req.url === "/cut") {
      // Promises 10 KB, sends 1 KB, then drops the connection.
      res.writeHead(200, { "content-type": "application/pdf", "content-length": "10240" });
      res.write(Buffer.alloc(1024));
      setTimeout(() => res.socket?.destroy(), 20);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const raw = createNodeRequest(httpRequest as unknown as RequestFn);
const init = (maxBytes: number) => ({ method: "GET" as const, signal: AbortSignal.timeout(5_000), maxBytes });

describe("createNodeRequest over a real socket", () => {
  it("cuts the body at exactly maxBytes, mid-chunk, and says so", async () => {
    const { body, truncated } = await raw(new URL(`${base}/big`), {}, init(10_500));

    expect(truncated).toBe(true);
    expect(body.byteLength).toBe(10_500);
  });

  it("reads a body under the cap whole", async () => {
    const { body, truncated } = await raw(new URL(`${base}/small`), {}, init(10_500));

    expect(truncated).toBe(false);
    expect(new TextDecoder().decode(body)).toBe("%PDF-1.4 tiny");
  });

  it("returns a redirect at its status line, without reading a body that never ends", async () => {
    const started = Date.now();

    const { res, body } = await raw(new URL(`${base}/redirect-forever`), {}, init(50 * 1024 * 1024));

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://www.vw.com.br/a.pdf");
    expect(body.byteLength).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("rejects a connection that closes before the body ends", async () => {
    await expect(raw(new URL(`${base}/cut`), {}, init(1_000_000))).rejects.toThrow();
  });
});
