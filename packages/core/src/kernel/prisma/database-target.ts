/**
 * One definition of "which database does DATABASE_URL name?" for every guard in
 * the repo.
 *
 * The seed and the database-writing test suites both have to answer that
 * question, and two independent answers would drift — with the drift showing up
 * in only one of the two places. Both import this.
 *
 * The result is a union rather than a boolean because the two consumers need
 * different splits. The seed refuses everything that is not `local`. The test
 * suites skip on `absent` (the environment is not equipped to run them) but fail
 * on `remote` (it is equipped and aimed at the wrong database), so collapsing
 * those two into "not local" would make one consumer wrong.
 */

/**
 * Hosts that mean "this machine".
 *
 * `host.docker.internal` is how a container reaches a Postgres running on the
 * host, so it is a legitimate local setup; a guard that rejected it would be
 * switched off rather than fixed.
 */
export const LOOPBACK_HOSTS = Object.freeze([
  "localhost",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
]);

export type DatabaseTarget =
  /** `DATABASE_URL` is unset or blank — no database is configured at all. */
  | { readonly kind: "absent" }
  /** Set, but not a URL we can read a host out of. Never treated as usable. */
  | { readonly kind: "unparseable"; readonly value: string }
  /**
   * A database on this machine.
   *
   * `database` is the name from the URL path, empty when the URL carries none.
   * It is part of the answer to "which database does DATABASE_URL name?" because
   * host alone does not identify one: every worktree database and the pristine
   * conversation base share `127.0.0.1:5433`, so a guard that reads only the
   * host cannot tell them apart.
   */
  | { readonly kind: "local"; readonly host: string; readonly database: string }
  | { readonly kind: "remote"; readonly host: string; readonly database: string };

/**
 * Classify the database `DATABASE_URL` points at.
 *
 * Fails closed: an unset, blank, malformed, or host-less value never comes back
 * as `local`. The cases nobody anticipated must not land in the permissive
 * branch, because that is what turns a guard into decoration.
 */
export function resolveDatabaseTarget(
  env: { readonly DATABASE_URL?: string | undefined } = process.env,
): DatabaseTarget {
  const raw = env.DATABASE_URL;
  if (raw === undefined || raw.trim() === "") {
    return { kind: "absent" };
  }

  let parsed: URL;
  try {
    // A connection password may itself contain "@" — the production URL does.
    // Splitting the string on "@" reads part of that password as the host, and a
    // guard that mis-parses fails permissive exactly when the target is most
    // sensitive. Let the URL parser find the host.
    parsed = new URL(raw);
  } catch {
    return { kind: "unparseable", value: raw };
  }

  const hostname = parsed.hostname;
  if (hostname === "") {
    return { kind: "unparseable", value: raw };
  }

  // The URL parser keeps IPv6 hosts in brackets ("[::1]"); compare the address.
  const host =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  // Postgres puts the database in the URL path: "/selectlub_foo". The parser
  // always yields a leading slash, and yields "/" alone when no database was
  // given — both reduce to "" here rather than to a name nothing can match.
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));

  return LOOPBACK_HOSTS.includes(host.toLowerCase())
    ? { kind: "local", host, database }
    : { kind: "remote", host, database };
}

/** Human-readable target for a refusal message, so a guard always names what it refused. */
export function describeDatabaseTarget(target: DatabaseTarget): string {
  switch (target.kind) {
    case "absent":
      return "DATABASE_URL is not set";
    case "unparseable":
      return "DATABASE_URL is not a readable URL";
    case "local":
    case "remote":
      return target.host;
  }
}
