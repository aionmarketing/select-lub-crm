/**
 * Reading configuration out of the process environment, once, with a stated
 * failure when something required is absent.
 *
 * The repository has been bitten twice by a missing variable resolving to a
 * silent default — `EVOLUTION_INSTANCE_NAME` falling back to a name nothing
 * seeds (it returned an empty unit instead of an error, see ci.yml), and
 * `DATABASE_URL` resolving to whatever a stray `.env` happened to name. Both
 * are failures to distinguish "absent" from "wrong". These readers make the
 * caller say which one it wants.
 */

/** Thrown when a required variable is absent or blank. */
export class MissingConfigError extends Error {
  constructor(name: string) {
    super(`${name} is not set`);
    this.name = "MissingConfigError";
  }
}

/** The environment to read from. `process.env`, or a literal in a test. */
export type Env = Record<string, string | undefined>;

/**
 * Reads a required string.
 *
 * @throws {MissingConfigError} When absent, empty, or whitespace.
 */
export function requireString(env: Env, name: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") throw new MissingConfigError(name);
  return raw;
}

/**
 * Reads an optional string.
 *
 * @returns The value, or `fallback` when absent or blank. Blank counts as
 *   absent: an empty variable in a deploy config means "unset", never "".
 */
export function optionalString(env: Env, name: string, fallback?: string): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw;
}

/**
 * Reads an integer.
 *
 * @returns `fallback` when absent or blank.
 * @throws {TypeError} When set to something that is not an integer, rather than
 *   quietly using the fallback — a typo'd interval should stop the process.
 */
export function integer(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new TypeError(`${name} must be an integer, got ${raw}`);
  return parsed;
}

/**
 * Reads a flag.
 *
 * @returns True only for `"1"` and `"true"` (case-insensitive). Anything else,
 *   including `"0"` and `"false"`, is false.
 */
export function flag(env: Env, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}
