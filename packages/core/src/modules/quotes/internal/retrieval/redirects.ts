/**
 * Following a search page's redirects by hand (oil-research-web-retrieval D1).
 *
 * The page fetcher keeps `redirect: "manual"` on every request, so each hop is seen here and
 * checked before anything is sent to it. Only a hop that stays on the same host is followed,
 * which is why the blocklist and the class the model gave the first URL still speak for the
 * last one: following off-host would land on a domain nobody classified.
 */
import { findBlock } from "@select-lub/core/db";
import { assertAllowedUrl } from "../net/guarded-http.js";
import type { FetchRefusal, FetchTransport } from "./page-fetcher.js";

/** Redirect hops one page fetch may follow, the HEAD and the GET together (D1). */
export const MAX_REDIRECT_HOPS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * A host and port compared without case or a leading `www.`: the only difference a followed
 * redirect may make. A port change is another host: it is another service.
 */
function comparableHost(url: URL): string {
  return url.host.toLowerCase().replace(/^www\./, "");
}

type Reply = Awaited<ReturnType<FetchTransport>>;

/**
 * Sends one request and follows same-host redirects by hand (D1).
 *
 * `redirect: "manual"` stays on every request, so each hop is seen here and checked before it
 * is sent: public https through {@link assertAllowedUrl}, the same host, and the blocklist. The
 * hop budget is shared between the HEAD and the GET through `hops`. `allowed` (the target's
 * robots.txt) is asked before the hop is followed, so a disallowed target is never requested.
 *
 * @returns The final reply and the URL that answered, or the refusal that stopped the chain.
 * @throws BlockedUrlError when a hop is not public https; the caller turns it into `blocked`.
 */
export async function requestFollowing(
  start: string,
  method: "GET" | "HEAD",
  transport: FetchTransport,
  signal: AbortSignal,
  hops: { left: number },
  allowed: (url: string) => Promise<boolean>,
): Promise<{ reply: Reply; url: string } | { refusal: FetchRefusal }> {
  let current = start;
  for (;;) {
    const reply = await transport(current, { method, signal, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(reply.status)) {
      return { reply, url: current };
    }
    const location = reply.headers.get("location");
    if (!location) {
      return { refusal: { kind: "redirect", message: `${reply.status} without a Location` } };
    }
    if (hops.left <= 0) {
      return { refusal: { kind: "redirect", message: `more than ${MAX_REDIRECT_HOPS} redirects` } };
    }
    hops.left -= 1;
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return { refusal: { kind: "redirect", message: `${reply.status} to an unparseable Location` } };
    }
    assertAllowedUrl(next);
    if (next.username !== "" || next.password !== "") {
      return { refusal: { kind: "redirect", message: `${reply.status} to a Location with credentials` } };
    }
    if (comparableHost(next) !== comparableHost(new URL(current))) {
      return { refusal: { kind: "redirect", message: `${reply.status} to another host (${next.host})` } };
    }
    // A floor, not a tiebreak: redundant while the host cannot change, kept so a later
    // relaxation of the host rule cannot open a hole.
    const block = findBlock(next.toString());
    if (block) {
      return { refusal: { kind: "redirect", message: `${reply.status} to a blocked domain (${block.reason})` } };
    }
    if (!(await allowed(next.toString()))) {
      return { refusal: { kind: "robots" } };
    }
    current = next.toString();
  }
}
