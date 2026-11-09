/**
 * Auth hook helpers: bearer parsing, `/api` prefix stripping, and unit scoping rules.
 * Shared by `registerAuthHook`, SPA routing, and route handlers that read `X-Unit-Id`.
 */

/**
 * Picks the active unit from the header when allowed, or the sole membership when unambiguous.
 *
 * @param header - Raw `X-Unit-Id` value; `undefined` is allowed only when the user has exactly one membership.
 * @param memberships - Unit ids the authenticated user belongs to.
 * @returns The resolved unit id, or `null` when the header is invalid or membership is ambiguous.
 */
export function resolveCurrentUnit(header: string | undefined, memberships: string[]): string | null {
  if (memberships.length === 0) {
    return null;
  }
  if (header) {
    return memberships.includes(header) ? header : null;
  }
  if (memberships.length === 1) {
    return memberships[0] ?? null;
  }
  return null;
}

/**
 * Extracts the JWT from an `Authorization: Bearer` header.
 *
 * @param authorization - Raw `Authorization` header value or array from Fastify.
 * @returns Bearer token string, or `undefined` when the header is missing or malformed.
 */
export function bearerToken(authorization: string | string[] | undefined): string | undefined {
  if (typeof authorization !== "string") {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)/i.exec(authorization.trim());
  return match?.[1];
}

/**
 * Normalizes a request URL to a path without query string or trailing slash.
 *
 * @param url - Full request URL including optional query string.
 * @returns Path only, with trailing slash removed except for the root `/`.
 */
export function requestPath(url: string) {
  const path = url.split("?")[0] ?? url;
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * True for unauthenticated liveness probes on `/health`.
 *
 * @param method - HTTP method (e.g. `GET`, `HEAD`).
 * @param path - Normalized path from {@link requestPath}.
 * @returns Whether the route skips JWT validation.
 */
export function isHealthPath(method: string, path: string) {
  return (method === "GET" || method === "HEAD") && path === "/health";
}

/**
 * Every path prefix the API owns.
 *
 * ADD A NEW ROUTE'S PREFIX HERE. A GET or HEAD path missing from this list is
 * treated as a static asset and **skips JWT validation entirely** — see
 * {@link isUnauthenticatedAssetRequest}. It fails open, not closed, so a new
 * read route left out of this list is reachable unauthenticated, and nothing
 * about the route itself gives that away.
 */
const API_PATH_PREFIXES = [
  "/health",
  "/auth",
  "/users",
  "/units",
  "/conversations",
  "/reports",
  "/follow-ups",
  "/follow-up-counts",
  "/vehicle-returns",
  "/return-reminders",
  "/scheduled-messages",
  "/channel",
  "/customers",
  "/reconciliation-pendings",
  "/vehicles",
  "/plate-lookups",
  "/services",
  "/tags",
  "/templates",
] as const;

/**
 * Rewrites `/api/...` URLs to in-app paths before Fastify routing.
 *
 * @param url - Incoming URL that may include the `/api` prefix and query string.
 * @returns URL with `/api` stripped from the path; query string is preserved.
 */
export function stripApiPrefix(url: string) {
  const q = url.indexOf("?");
  const path = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? "" : url.slice(q);
  if (path === "/api") {
    return `/${query}`;
  }
  if (path.startsWith("/api/")) {
    return `${path.slice("/api".length)}${query}`;
  }
  return url;
}

/**
 * True when the path belongs to JSON API routes rather than static SPA assets.
 *
 * @param path - Normalized path from {@link requestPath}.
 * @returns Whether the path is a protected JSON API route.
 */
export function isApiRoutePath(path: string) {
  return API_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * True for GET/HEAD non-API paths that skip JWT validation (static files).
 *
 * @param method - HTTP method.
 * @param path - Normalized path from {@link requestPath}.
 * @returns Whether static asset requests bypass auth.
 */
export function isUnauthenticatedAssetRequest(method: string, path: string) {
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }
  return !isApiRoutePath(path);
}

/**
 * True for routes that authenticate but do not require a resolved current unit.
 *
 * @param method - HTTP method.
 * @param path - Normalized path from {@link requestPath}.
 * @returns Whether `X-Unit-Id` resolution is skipped after JWT validation.
 */
export function isUnitExemptPath(method: string, path: string) {
  if (path === "/auth/me" && method === "GET") {
    return true;
  }
  if (path === "/users" && method === "POST") {
    return true;
  }
  if (method === "PUT" && /^\/users\/[^/]+\/units$/.test(path)) {
    return true;
  }
  if (path === "/channel/status" && method === "GET") {
    return true;
  }
  return false;
}
