/**
 * Test design (testing-strategy): the suite's network backstop (switch-oil-research-to-openai task 1.3, review of #215)
 *
 * SUT: installNetworkGuard / takeNetworkViolations (test/network-guard.ts), installed for every
 *   core test by test/network-guard.setup.ts.
 *
 * Oracle: tasks.md 1.3 and AGENTS.md: `pnpm test` opens no connection to OpenAI,
 *   Motul or Tecfil, or to any non-loopback host. A connection to loopback still works.
 *
 * Cells
 *   fetch to each provider host  | refused before connecting, recorded
 *   raw TLS / TCP connect        | refused, recorded
 *   loopback server              | reached
 */
import { createServer } from "node:http";
import net from "node:net";
import tls from "node:tls";
import { describe, expect, it } from "vitest";
import { isLoopbackHost, takeNetworkViolations } from "./network-guard.js";

describe("the test network guard", () => {
  it.each([
    "https://api.openai.com/v1/responses",
    "https://gateway-apim.motul.com/oil-advisor/vehicle-brands",
    "https://catalogoexpresso.com.br/ideia2001/api/v2/montadoras",
    "https://example.com/",
  ])("refuses fetch(%s) and records it", async (url) => {
    await expect(fetch(url, { method: "POST", body: "{}" })).rejects.toThrow();
    const refused = takeNetworkViolations();
    expect(refused.map((v) => v.host)).toContain(new URL(url).hostname);
  });

  it("refuses a raw TLS and TCP connect to a public host", async () => {
    const closed = (socket: net.Socket) =>
      new Promise<void>((resolve) => {
        socket.on("error", () => undefined);
        socket.on("close", () => resolve());
      });
    await closed(tls.connect({ host: "api.openai.com", port: 443, servername: "api.openai.com" }));
    await closed(net.connect(443, "8.8.8.8"));
    expect(takeNetworkViolations().map((v) => v.host)).toEqual(["api.openai.com", "8.8.8.8"]);
  });

  it("lets a loopback connection through", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(takeNetworkViolations()).toEqual([]);
  });

  it("knows loopback from a public host", () => {
    expect(["localhost", "127.0.0.1", "::1", "[::1]", "app.localhost"].every(isLoopbackHost)).toBe(true);
    expect(["api.openai.com", "10.0.0.5", "192.168.0.1", "8.8.8.8"].some(isLoopbackHost)).toBe(false);
  });
});
