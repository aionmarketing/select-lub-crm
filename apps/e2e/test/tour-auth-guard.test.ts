/**
 * Oracle: openspec/changes/tours-local-supabase/specs/repo-foundation/spec.md,
 * requirement "No tour signs in to a hosted Supabase" — scenarios "The tour env
 * is loopback-only", "The production login cannot be inherited", "A non-loopback
 * Supabase URL is refused" and "Local Supabase is not running". Expected values
 * come from that text and from the committed test user, never from a run.
 *
 * WHY THIS LEVEL. The API's token verification is a server-side call, so a
 * browser listener cannot see it (the same reasoning as
 * `tour-provider-guard.test.ts`). What decides where it goes is the env the tour
 * API is spawned with, and that env is built by `tourAuthEnv()` — the function
 * `tours-config.shared.ts` assigns onto `process.env` and spreads into every
 * server, and `run-tours.mjs` hands to the database seed. So this file checks
 * that function's output, with no `.env` loaded into this process.
 *
 * WHICH NAMES. The list of inheritable names is not taken from the module under
 * test — a name it forgot would then be forgotten here too. It is the fixed set
 * below PLUS every Supabase / login / seed-user name `.env.example` documents,
 * so a variable added there later fails this test until the tour stack
 * overrides it.
 *
 * SEEN RED (task 2.1): before `tour-auth-env.ts` existed the suite failed at
 * import; with `SUPABASE_PUBLISHABLE_KEY` dropped from the override set, "the
 * production login cannot be inherited" fails naming it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOCAL_SUPABASE_NOT_RUNNING_HINT, parseLocalSupabaseStatus } from "../local-supabase.js";
import { isHostedSupabaseRequest, TOUR_SUPABASE_URL, TOUR_TEST_USER, tourAuthEnv } from "../tour-auth-env.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Hosts that mean "this machine" for an auth endpoint, as `URL.hostname` spells them. */
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** A shell or `.env` that names a hosted project and the real login. */
const HOSTED_URL = "https://prodprojectref.supabase.co";
const inheritedProduction: Record<string, string> = {
  SUPABASE_URL: HOSTED_URL,
  SUPABASE_ANON_KEY: "hosted-anon-key",
  SUPABASE_PUBLISHABLE_KEY: "hosted-publishable-key",
  SUPABASE_SERVICE_ROLE_KEY: "hosted-service-role-key",
  VITE_SUPABASE_URL: HOSTED_URL,
  VITE_SUPABASE_ANON_KEY: "hosted-anon-key",
  VITE_SUPABASE_DB_PASSWORD: "hosted-db-password",
  VITE_MVP_LOGIN_EMAIL: "real-person@example.com",
  VITE_MVP_LOGIN_PASSWORD: "real-password",
  SEED_USER_A_ID: "00000000-0000-4000-8000-00000000000a",
  SEED_USER_B_ID: "00000000-0000-4000-8000-00000000000b",
};

/** Every Supabase, login and seed-user name `.env.example` documents, set or commented. */
function documentedAuthNames(): string[] {
  const example = readFileSync(path.join(repoRoot, ".env.example"), "utf8");
  const names = new Set<string>();
  for (const match of example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)) {
    const name = match[1]!;
    if (/SUPABASE|MVP_LOGIN|SEED_USER/.test(name)) names.add(name);
  }
  return [...names];
}

const LOCAL_ANON_KEY = "local-anon-key-from-supabase-status";
const LOCAL_SERVICE_ROLE_KEY = "local-service-role-key-from-supabase-status";
const LOCAL_KEYS = { anonKey: LOCAL_ANON_KEY, serviceRoleKey: LOCAL_SERVICE_ROLE_KEY };

describe("the tour auth env", () => {
  it("points the SPA and the API at a loopback Supabase", () => {
    const built = tourAuthEnv(LOCAL_KEYS);

    for (const name of ["VITE_SUPABASE_URL", "SUPABASE_URL"]) {
      const value = built[name];
      expect(value, `${name} is not set by the tour stack`).toBeTruthy();
      expect(LOOPBACK, `${name} host is ${new URL(value!).hostname}`).toContain(new URL(value!).hostname);
    }
    expect(built.VITE_SUPABASE_URL).toBe(TOUR_SUPABASE_URL);
    // The API and the SPA must verify against the same Auth, or the SPA's token
    // is one the API cannot read.
    expect(built.SUPABASE_URL).toBe(built.VITE_SUPABASE_URL);
    for (const name of ["VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY"]) {
      expect(built[name], name).toBe(LOCAL_ANON_KEY);
    }
  });

  it("signs in as the committed test user and links that user to the seed", () => {
    const built = tourAuthEnv(LOCAL_KEYS);

    expect(built.VITE_MVP_LOGIN_EMAIL).toBe(TOUR_TEST_USER.email);
    expect(built.VITE_MVP_LOGIN_PASSWORD).toBe(TOUR_TEST_USER.password);
    expect(built.SEED_USER_A_ID).toBe(TOUR_TEST_USER.id);
    // A reserved test domain, so the committed address can belong to nobody.
    expect(TOUR_TEST_USER.email).toMatch(/@[a-z0-9.-]+\.(?:test|example|localhost)$/);
  });

  it("the production login cannot be inherited", () => {
    const names = new Set([...Object.keys(inheritedProduction), ...documentedAuthNames()]);
    const spawned = { ...inheritedProduction, ...tourAuthEnv(LOCAL_KEYS) };
    const productionValues = new Set(Object.values(inheritedProduction));

    for (const name of names) {
      expect(Object.keys(tourAuthEnv(LOCAL_KEYS)), `${name} is not overridden`).toContain(name);
      expect(productionValues.has(spawned[name]!), `${name} still carries the inherited value`).toBe(false);
    }
    // The tour API creates users (the Usuarios tours drive POST /users), so it
    // gets a service-role key — the LOCAL stack's, never the inherited one.
    expect(spawned.SUPABASE_SERVICE_ROLE_KEY).toBe(LOCAL_SERVICE_ROLE_KEY);
  });

  it.each([
    HOSTED_URL,
    "http://192.168.0.10:54321",
    "http://127.0.0.1.nip.io:54321",
  ])("refuses the non-loopback Supabase URL %s", (url) => {
    expect(() => tourAuthEnv({ ...LOCAL_KEYS, url })).toThrow(new URL(url).hostname);
  });

  it("refuses to build without the local anon key", () => {
    expect(() => tourAuthEnv({ ...LOCAL_KEYS, anonKey: "" })).toThrow(/anon key/i);
  });

  it("refuses to build without the local service-role key", () => {
    expect(() => tourAuthEnv({ ...LOCAL_KEYS, serviceRoleKey: "" })).toThrow(/service-role key/i);
  });
});

describe("the tour's browser check", () => {
  it.each([
    `${HOSTED_URL}/auth/v1/token?grant_type=password`,
    "https://prodprojectref.supabase.com/rest/v1/",
    "https://SUPABASE.CO/",
  ])("flags %s as a hosted Supabase request", (url) => {
    expect(isHostedSupabaseRequest(url)).toBe(true);
  });

  it.each([
    `${TOUR_SUPABASE_URL}/auth/v1/token?grant_type=password`,
    "http://127.0.0.1:5174/api/auth/me",
    "https://notsupabase.co.example/",
  ])("leaves %s alone", (url) => {
    expect(isHostedSupabaseRequest(url)).toBe(false);
  });
});

describe("reading the local Supabase", () => {
  it("returns the anon and service keys `supabase status -o json` prints", () => {
    const status = parseLocalSupabaseStatus({
      ok: true,
      output: 'warn: something\n{"ANON_KEY":"a","SERVICE_ROLE_KEY":"s","DB_URL":"postgresql://postgres:postgres@127.0.0.1:54322/postgres"}\n',
    });

    expect(status).toEqual({ anonKey: "a", serviceRoleKey: "s" });
  });

  it.each([
    { label: "status failed", ok: false, output: "failed to inspect container health" },
    { label: "no JSON", ok: true, output: "supabase local development setup is not running." },
    { label: "keys missing", ok: true, output: '{"DB_URL":"x"}' },
  ])("names the start command when local Supabase is not running ($label)", ({ ok, output }) => {
    expect(() => parseLocalSupabaseStatus({ ok, output })).toThrow(LOCAL_SUPABASE_NOT_RUNNING_HINT);
    expect(LOCAL_SUPABASE_NOT_RUNNING_HINT).toContain("pnpm tours:supabase:start");
  });
});
