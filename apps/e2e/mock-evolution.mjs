/**
 * Loopback Evolution stand-in for Playwright. Answers connectionState as `open`
 * so enqueue/schedule succeed without calling a live host or sending WhatsApp.
 */
import { createServer } from "node:http";
import { env, stdout } from "node:process";

const port = Number(env.E2E_EVOLUTION_PORT ?? 18080);
const host = "127.0.0.1";

createServer((req, res) => {
  const url = req.url ?? "";
  if (url === "/health" || url.startsWith("/instance/connectionState/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ instance: { state: "open" }, state: "open" }));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(port, host, () => {
  stdout.write(`e2e evolution mock listening on http://${host}:${port}\n`);
});
