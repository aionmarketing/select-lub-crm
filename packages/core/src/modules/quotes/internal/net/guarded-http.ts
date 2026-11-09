/**
 * HTTP for URLs the quote pipeline did not choose: web pages from search results and the manuals
 * they link to. Every URL is untrusted, so this is the one way the quotes module reaches them
 * (review of #180, 2026-09-25: SSRF).
 *
 * - **https only.** `http:`, `data:`, `file:` and everything else are refused.
 * - **Public addresses only.** A hostname of `localhost`, `*.localhost` or `*.internal` (Fly's
 *   private network) is refused by name; an IP literal, and every address a name resolves to,
 *   must be public — not loopback, private (10/8, 172.16/12, 192.168/16, fc00::/7), link-local
 *   (169.254/16 including 169.254.169.254, fe80::/10), 0.0.0.0/8, CGNAT (100.64/10),
 *   documentation, multicast or reserved. IPv6 is public only inside global unicast 2000::/3,
 *   less its special-purpose and documentation blocks. An IPv6 address that carries an IPv4
 *   one — mapped, compatible, translated, NAT64 `64:ff9b::/96`, 6to4 — is judged as that IPv4
 *   address; the local-use NAT64 prefix `64:ff9b:1::/48`, whose embedding cannot be known, is
 *   refused. Hosts are read through the URL parser, so `https://2130706433/`,
 *   `https://0x7f000001/` and `https://127.1/` are all 127.0.0.1.
 * - **Checked where it connects.** The resolution runs in the connection's own `lookup` hook,
 *   so the address checked is the address dialled: a name cannot resolve to a public address
 *   for the check and a private one for the connection (DNS rebinding).
 * - **Redirects are followed by hand**, each hop checked again, at most {@link MAX_REDIRECTS}. A
 *   redirect's own body is never read: the socket is dropped at the status line.
 * - **Bodies are capped**: reading stops at `maxBytes` and says so; a connection that closes
 *   before the body ends is an error, not a short body.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";

/** Hops followed before a redirect chain is refused. */
export const MAX_REDIRECTS = 5;

/** Why a URL was refused before, or while, connecting. */
export class BlockedUrlError extends Error {
  override name = "BlockedUrlError";
}

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

function isPublicIpv4(ip: string): boolean {
  const o = ipv4Octets(ip);
  if (!o) return false;
  const [a, b] = o as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (o[2] === 0 || o[2] === 2)) return false; // IETF assignments, TEST-NET-1
  if (a === 192 && b === 88 && o[2] === 99) return false; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && o[2] === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && o[2] === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Expands an IPv6 address to its eight 16-bit groups. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const o = ipv4Octets(maybeV4);
    if (!o) return null;
    tail = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!];
    text = text.slice(0, lastColon + 1) + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === "" ? [] : s.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]!);
  const back = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - back.length : 0;
  const groups = [...head, ...Array(fill).fill(0), ...back];
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups;
}

/** Two 16-bit groups as a dotted IPv4 address. */
function dotted(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** The IPv4 address an IPv6 one carries, when it carries one where it can be read. */
function embeddedIpv4(g: number[]): string | null {
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return dotted(g[6]!, g[7]!); // mapped ::ffff:0:0/96
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return dotted(g[6]!, g[7]!); // translated ::ffff:0:0:0/96
  if (zero(0, 6)) return dotted(g[6]!, g[7]!); // compatible ::/96, including :: and ::1
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return dotted(g[6]!, g[7]!); // NAT64 64:ff9b::/96
  if (g[0] === 0x2002) return dotted(g[1]!, g[2]!); // 6to4 2002::/16
  return null;
}

function isPublicIpv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return false;
  const v4 = embeddedIpv4(g);
  if (v4 !== null) return isPublicIpv4(v4);
  // Only global unicast is public. Outside it: fc00::/7, fe80::/10, fec0::/10, ff00::/8, 100::/64,
  // and the local-use NAT64 64:ff9b:1::/48 — all refused by this one test.
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1]! < 0x0200) return false; // 2001::/23 special purpose: Teredo, benchmarking, ORCHID
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation 2001:db8::/32
  if (g[0] === 0x3fff && g[1]! < 0x1000) return false; // documentation 3fff::/20
  return true;
}

/** Whether an IP address is on the public internet. */
export function isPublicAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPublicIpv4(ip);
  if (version === 6) return isPublicIpv6(ip);
  return false;
}

/**
 * Checks a URL before anything connects: https, a name that is not local, and — when the host
 * is an IP literal — a public address.
 *
 * @throws BlockedUrlError naming why.
 */
export function assertAllowedUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new BlockedUrlError("not a URL");
  }
  if (url.protocol !== "https:") throw new BlockedUrlError(`scheme ${url.protocol} is not allowed`);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new BlockedUrlError(`host ${host || "(empty)"} is not public`);
  }
  if (isIP(host) && !isPublicAddress(host)) throw new BlockedUrlError(`address ${host} is not public`);
  return url;
}

/** A `dns.lookup`-shaped function. */
export type LookupFn = (
  hostname: string,
  options: { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * A `lookup` for the connection: resolves the name, refuses it unless EVERY address is public,
 * and hands the connection the first one. Refusing on any private address, not only the first,
 * means a name cannot hide a private address behind a public one.
 *
 * @param base - The resolver; tests inject one. Defaults to `dns.lookup`.
 */
export function guardedLookup(base: LookupFn = dnsLookup as unknown as LookupFn): NonNullable<RequestOptions["lookup"]> {
  return ((hostname: string, options: unknown, callback: (err: Error | null, address?: string | LookupAddress[], family?: number) => void) => {
    const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
    base(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!addresses?.length) return callback(new BlockedUrlError(`${hostname} did not resolve`));
      const refused = addresses.find((a) => !isPublicAddress(a.address));
      if (refused) return callback(new BlockedUrlError(`${hostname} resolves to ${refused.address}, which is not public`));
      if (wantsAll) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  }) as unknown as NonNullable<RequestOptions["lookup"]>;
}

/** A response, with its body read up to the cap. */
export type GuardedResponse = {
  status: number;
  /** The URL that answered, after any redirects. */
  url: string;
  headers: { get(name: string): string | null };
  body: Uint8Array;
  /** True when the body passed `maxBytes` and reading stopped. */
  truncated: boolean;
  text(): Promise<string>;
};

/** What one request needs. */
export type GuardedRequestInit = {
  method: "GET" | "HEAD";
  signal: AbortSignal;
  /** Stop reading the body past this many bytes. */
  maxBytes: number;
  /** "follow": redirects are followed, each hop checked; "manual": a 3xx is returned as is. */
  redirect?: "follow" | "manual";
};

/** A guarded client; `apply` is exposed for tests. */
export type GuardedHttp = (url: string, init: GuardedRequestInit) => Promise<GuardedResponse>;

/** One raw HTTPS exchange, injectable so tests never reach the network. */
export type RawRequest = (url: URL, options: RequestOptions, init: GuardedRequestInit) => Promise<{ res: IncomingMessage; body: Uint8Array; truncated: boolean }>;

/** A `https.request`-shaped function; tests pass `http.request` against a local server. */
export type RequestFn = (url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest;

/**
 * The raw exchange over a real socket: the body read up to `maxBytes` and cut exactly there; a
 * redirect's body never read; a connection that closes before the body ends, an error.
 *
 * @param requestFn - Defaults to `https.request`.
 */
export function createNodeRequest(requestFn: RequestFn = httpsRequest as unknown as RequestFn): RawRequest {
  return (url, options, init) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        outcome();
      };
      const req = requestFn(url, { ...options, method: init.method, signal: init.signal }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          // Only the status and the Location matter; the body is dropped unread.
          finish(() => resolve({ res, body: new Uint8Array(), truncated: false }));
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          const room = init.maxBytes - total;
          if (chunk.length > room) {
            if (room > 0) chunks.push(chunk.subarray(0, room));
            finish(() => resolve({ res, body: Buffer.concat(chunks), truncated: true }));
            res.destroy();
            return;
          }
          chunks.push(chunk);
          total += chunk.length;
        });
        res.on("end", () => finish(() => resolve({ res, body: Buffer.concat(chunks), truncated: false })));
        res.on("error", (err) => finish(() => reject(err)));
        res.on("close", () => finish(() => reject(new Error("the connection closed before the body ended"))));
      });
      req.on("error", (err) => finish(() => reject(err)));
      req.end();
    });
}

/**
 * @param deps.lookup - The resolver behind {@link guardedLookup}; tests inject one.
 * @param deps.request - The raw exchange; tests inject one.
 * @returns A client that refuses anything but public https, checked at every hop.
 */
export function createGuardedHttp(deps: { lookup?: LookupFn; request?: RawRequest } = {}): GuardedHttp {
  const lookup = guardedLookup(deps.lookup);
  const raw = deps.request ?? createNodeRequest();
  return async (start, init) => {
    let url = assertAllowedUrl(start);
    for (let hop = 0; ; hop += 1) {
      const { res, body, truncated } = await raw(
        url,
        { lookup, headers: { "accept-encoding": "identity", "user-agent": "select-lub-crm (oil manual reader)" } },
        { ...init, maxBytes: init.method === "HEAD" ? 0 : init.maxBytes },
      );
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (init.redirect !== "manual" && status >= 300 && status < 400 && location) {
        if (hop >= MAX_REDIRECTS) throw new BlockedUrlError(`more than ${MAX_REDIRECTS} redirects`);
        // Each hop is checked again: a public page may redirect anywhere.
        url = assertAllowedUrl(new URL(location, url));
        continue;
      }
      const headers = res.headers;
      return {
        status,
        url: url.href,
        headers: { get: (name: string) => {
          const value = headers[name.toLowerCase()];
          return Array.isArray(value) ? value.join(", ") : (value ?? null);
        } },
        body,
        truncated,
        text: async () => new TextDecoder().decode(body),
      };
    }
  };
}
