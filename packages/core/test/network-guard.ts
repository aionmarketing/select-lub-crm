/**
 * The test suite's network backstop (switch-oil-research-to-openai task 1.3, review of #215).
 *
 * Every socket a test opens goes through `net.Socket.prototype.connect`: Node's `fetch` (undici),
 * `https.request` and `tls.connect` all reach it. A connection to anything but loopback or a local
 * socket path is refused before any packet leaves: OpenAI (`api.openai.com`),
 * Motul, Tecfil, APIBrasil, or any other public host. The refusal is
 * recorded as well as raised, and the setup file fails the test after it ends, so a caller that
 * swallows the connection error (an adapter answering `unavailable`) still cannot hide it.
 *
 * DNS lookups are not intercepted: a lookup sends no request to the provider, and some guards under
 * test resolve names on purpose.
 */
import net from "node:net";

/** A refused connection. */
export type NetworkViolation = { host: string; port: number | string | null };

const violations: NetworkViolation[] = [];
let installed = false;

/** Whether a host is this machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "" || h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1" || /^127\./.test(h) || h === "::ffff:127.0.0.1" || h.endsWith(".localhost");
}

/** The host and port a `connect` call names, or a local socket path. */
function target(args: unknown[]): { path: string } | NetworkViolation {
  const [first, second] = args;
  // `net.connect(...)` hands `connect` its normalized arguments as one array: `[options, cb]`.
  if (Array.isArray(first)) return target(first as unknown[]);
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const options = first as { path?: string; host?: string; port?: number | string };
    if (typeof options.path === "string") return { path: options.path };
    return { host: options.host ?? "localhost", port: options.port ?? null };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return { path: first };
  return { host: typeof second === "string" ? second : "localhost", port: (first as number | string | undefined) ?? null };
}

/** Patches the socket's `connect` once per worker. */
export function installNetworkGuard(): void {
  if (installed) return;
  installed = true;
  const original = net.Socket.prototype.connect as (...args: unknown[]) => net.Socket;
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]): net.Socket {
    const to = target(args);
    if ("host" in to && !isLoopbackHost(to.host)) {
      violations.push(to);
      const error = Object.assign(new Error(`test network guard: refused a connection to ${to.host}:${to.port ?? "?"} — tests reach no provider`), { code: "ETESTNETWORK" });
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return original.apply(this, args);
  } as typeof net.Socket.prototype.connect;
}

/** The refusals since the last call, cleared. A test that provokes one on purpose drains it. */
export function takeNetworkViolations(): NetworkViolation[] {
  return violations.splice(0, violations.length);
}
