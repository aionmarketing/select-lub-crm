/**
 * Derive a per-worktree database name, and rewrite a .env to point at it.
 *
 * Git worktrees are isolated in git but not in data: they share whatever
 * DATABASE_URL names. Every worktree on this machine pointing at one database
 * means concurrent sessions write the same rows, which is the likeliest cause of
 * the parallel-test flakiness this repo has been living with.
 *
 * Both functions here are pure so they can be tested without a database, a
 * filesystem, or a second worktree.
 */
import { createHash } from "node:crypto";

/** Postgres truncates identifiers at 63 bytes; past that, distinct names would silently collide. */
const MAX_IDENTIFIER_LENGTH = 63;
const PREFIX = "selectlub_";

/**
 * The pristine database holding real conversations, which worktree databases are
 * created from with `CREATE DATABASE ... TEMPLATE`.
 *
 * It must never be seeded. The seed only decorates conversations that have no
 * customer, so cadastro written here is inherited by every database created from
 * it afterwards and **cannot be removed by re-seeding** — those conversations
 * then have customers, so the seed skips them. The only repair is rebuilding the
 * base from Evolution. Live-scrub (`db:scrub-live`) is the allowed write that
 * removes real message bodies after import.
 *
 * Nothing should connect to it either: Postgres refuses to copy a database that
 * has open sessions, so a base someone is working against cannot be cloned.
 *
 * Named here rather than in the guard because this module owns database naming.
 * Note the collision this implies: a worktree directory literally called
 * `realbase` derives this same name and would be refused by the seed. That is
 * the conservative failure and is left as-is rather than engineered around.
 */
export const PRISTINE_BASE_DATABASE = `${PREFIX}realbase`;

/** Env keys that name a database and must not be inherited from the main checkout. */
export const DATABASE_ENV_KEYS = Object.freeze([
  "DATABASE_URL",
  "DIRECT_URL",
  "DATABASE_URL_TEST",
]);

/**
 * Turn a worktree directory name into a Postgres database name.
 *
 * Lowercased with every non-alphanumeric run collapsed to a single underscore,
 * because an unquoted Postgres identifier cannot contain a hyphen. If the result
 * would exceed the identifier limit it is truncated and given a hash suffix
 * derived from the full name — worktree names here share long prefixes and
 * differ only in a trailing hash, so plain truncation is exactly the case that
 * would collide.
 */
export function deriveWorktreeDatabaseName(worktreeDirectoryName: string): string {
  const slug = worktreeDirectoryName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (slug === "") {
    // No usable characters at all; fall back to a pure hash so the caller still
    // gets a valid, stable, unique name rather than the bare prefix.
    return `${PREFIX}${shortHash(worktreeDirectoryName)}`;
  }

  const full = `${PREFIX}${slug}`;
  if (full.length <= MAX_IDENTIFIER_LENGTH) return full;

  const suffix = `_${shortHash(worktreeDirectoryName)}`;
  const keep = MAX_IDENTIFIER_LENGTH - PREFIX.length - suffix.length;
  return `${PREFIX}${slug.slice(0, keep)}${suffix}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/** Where local Compose publishes Postgres (host 5433 avoids a local 5432, common on Windows). */
export const LOCAL_POSTGRES_ENDPOINT = "127.0.0.1:5433";

/**
 * Build the connection string for a local per-worktree database.
 *
 * This REPLACES the endpoint rather than editing the inherited one. The main
 * checkout's .env points at the hosted database, so swapping only the database
 * name out of it would leave a worktree still aimed at the hosted host — the
 * exact isolation this change exists to create, silently absent.
 */
export function buildLocalDatabaseUrl(
  databaseName: string,
  credentials: { user?: string | undefined; password?: string | undefined } = {},
): string {
  const user = credentials.user ?? "selectlub";
  const password = credentials.password ?? "selectlub";
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${LOCAL_POSTGRES_ENDPOINT}/${databaseName}`;
}

/**
 * Rewrite the database-naming lines of a .env so the copy targets `databaseName`.
 *
 * Only lines that are actually set are rewritten; a commented-out key stays
 * commented, because uncommenting DIRECT_URL would switch on a direct
 * connection the local Compose setup does not need. Comments, ordering,
 * unrelated keys and line endings are preserved — the file carries credentials
 * and prose that must survive the copy unchanged.
 */
export function rewriteEnvForWorktree(envContents: string, databaseName: string): string {
  const newline = envContents.includes("\r\n") ? "\r\n" : "\n";
  const rawLines = envContents.split(/\r?\n/);

  const readValue = (wanted: string): string | undefined => {
    for (const line of rawLines) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match?.[1] === wanted) return match[2];
    }
    return undefined;
  };

  // Credentials come from the file so a customised local Postgres still works;
  // the ENDPOINT never does, because the inherited one may be the hosted host.
  const localUrl = buildLocalDatabaseUrl(databaseName, {
    user: readValue("POSTGRES_USER"),
    password: readValue("POSTGRES_PASSWORD"),
  });

  let sawDatabaseUrl = false;

  const lines = rawLines.map((line) => {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match === null) return line;

    const key = match[1];
    if (key === undefined) return line;
    if (key === "POSTGRES_DB") return `${key}=${databaseName}`;
    if (!DATABASE_ENV_KEYS.includes(key)) return line;
    if (key === "DATABASE_URL") sawDatabaseUrl = true;

    // DATABASE_URL_TEST must not be the same database as DATABASE_URL: the
    // API test suite truncates whatever it names.
    return key === "DATABASE_URL_TEST"
      ? `${key}=${buildLocalDatabaseUrl(`${databaseName}_test`, {
          user: readValue("POSTGRES_USER"),
          password: readValue("POSTGRES_PASSWORD"),
        })}`
      : `${key}=${localUrl}`;
  });

  if (!sawDatabaseUrl) lines.push(`DATABASE_URL=${localUrl}`);

  return lines.join(newline);
}
