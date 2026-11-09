/**
 * The local Supabase Auth the exploratory tours sign in to.
 *
 *   pnpm tours:supabase:start   # supabase start (auth only) + create the test user
 *   pnpm tours:supabase:stop    # supabase stop — removes the containers
 *   tsx local-supabase.ts prepare   # what run-tours.mjs calls before every run
 *
 * `prepare` reads the running stack's keys with `supabase status -o json`,
 * makes sure the committed test user exists with the committed password, and
 * prints ONE JSON line for the runner: the tour auth env (`tourAuthEnv`) plus
 * `TOUR_SUPABASE_ANON_KEY` / `TOUR_SUPABASE_SERVICE_ROLE_KEY`. Both keys are
 * the local CLI's public demo values and open nothing but the containers on
 * this machine; the line goes to the runner's pipe, not the terminal.
 *
 * Every request this module makes goes to {@link TOUR_SUPABASE_URL}, a
 * committed loopback constant. OpenSpec: `tours-local-supabase`.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOUR_SUPABASE_URL, TOUR_TEST_USER, tourAuthEnv } from "./tour-auth-env.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** What a tour run is told when local Supabase does not answer. */
export const LOCAL_SUPABASE_NOT_RUNNING_HINT =
  "local Supabase is not running — start it with `pnpm tours:supabase:start` (Docker must be up), then rerun the tours";

/** Keys the running local stack reports. */
export type LocalSupabaseKeys = { anonKey: string; serviceRoleKey: string };

/**
 * Reads `supabase status -o json` output.
 *
 * The CLI prints warnings (a certificate notice on this machine, among others)
 * around the JSON, so the object is cut out from the first `{` to the last `}`.
 *
 * @param result - Whether the command exited 0, and its combined output.
 * @returns The anon and service-role keys.
 * @throws With {@link LOCAL_SUPABASE_NOT_RUNNING_HINT} when the stack is not up.
 */
export function parseLocalSupabaseStatus(result: { ok: boolean; output: string }): LocalSupabaseKeys {
  const start = result.output.indexOf("{");
  const end = result.output.lastIndexOf("}");
  if (!result.ok || start === -1 || end < start) {
    // The failure text names no key, so it is safe to show.
    throw new Error(`${LOCAL_SUPABASE_NOT_RUNNING_HINT}\n${result.ok ? "" : result.output.trim()}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.output.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error(LOCAL_SUPABASE_NOT_RUNNING_HINT);
  }
  const anonKey = parsed.ANON_KEY;
  const serviceRoleKey = parsed.SERVICE_ROLE_KEY;
  if (typeof anonKey !== "string" || !anonKey || typeof serviceRoleKey !== "string" || !serviceRoleKey) {
    throw new Error(LOCAL_SUPABASE_NOT_RUNNING_HINT);
  }
  return { anonKey, serviceRoleKey };
}

/**
 * Runs the pinned Supabase CLI against `apps/e2e/supabase/`.
 *
 * Through `pnpm exec`, which on Windows is a `.cmd` shim and needs a shell; the
 * arguments are fixed and space-free, so the shell splits nothing.
 *
 * @param args - CLI arguments, before `--workdir`.
 * @param capture - Capture output instead of streaming it.
 * @returns Exit status and, when captured, combined output.
 */
function supabaseCli(args: string[], capture: boolean): { ok: boolean; output: string } {
  try {
    const output = execFileSync("pnpm", ["exec", "supabase", ...args, "--workdir", here], {
      cwd: here,
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: process.platform === "win32",
    });
    return { ok: true, output: output ?? "" };
  } catch (error) {
    const shaped = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${shaped.stdout ?? ""}${shaped.stderr ?? ""}${shaped.message ?? ""}` };
  }
}

/**
 * Reads the running stack's keys and checks Auth answers on the loopback.
 *
 * @returns The local keys.
 * @throws With {@link LOCAL_SUPABASE_NOT_RUNNING_HINT} when it is not up.
 */
export async function readLocalSupabase(): Promise<LocalSupabaseKeys> {
  const keys = parseLocalSupabaseStatus(supabaseCli(["status", "-o", "json"], true));
  const health = await fetch(`${TOUR_SUPABASE_URL}/auth/v1/health`, { headers: { apikey: keys.anonKey } }).catch(
    () => null,
  );
  if (!health?.ok) {
    throw new Error(`${LOCAL_SUPABASE_NOT_RUNNING_HINT}\n(Auth on ${TOUR_SUPABASE_URL} did not answer)`);
  }
  return keys;
}

/**
 * Makes the committed test user exist in local Auth with the committed id,
 * email and password — creating it, or resetting it when it drifted.
 *
 * Through the Auth admin API, not SQL, so GoTrue writes its own `auth.users`
 * and `auth.identities` rows.
 *
 * @param serviceRoleKey - The local service-role key.
 * @throws When Auth refuses either call.
 */
export async function ensureTestUser(serviceRoleKey: string): Promise<void> {
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
  const attributes = {
    email: TOUR_TEST_USER.email,
    password: TOUR_TEST_USER.password,
    email_confirm: true,
  };
  const existing = await fetch(`${TOUR_SUPABASE_URL}/auth/v1/admin/users/${TOUR_TEST_USER.id}`, { headers });
  const response =
    existing.status === 404
      ? await fetch(`${TOUR_SUPABASE_URL}/auth/v1/admin/users`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: TOUR_TEST_USER.id, ...attributes }),
        })
      : await fetch(`${TOUR_SUPABASE_URL}/auth/v1/admin/users/${TOUR_TEST_USER.id}`, {
          method: "PUT",
          headers,
          body: JSON.stringify(attributes),
        });
  if (!response.ok) {
    throw new Error(`local Supabase: could not create the tour test user (${response.status}) ${await response.text()}`);
  }
  const user = (await response.json()) as { id?: string };
  if (user.id !== TOUR_TEST_USER.id) {
    throw new Error(`local Supabase: the tour test user came back with id ${user.id}, not ${TOUR_TEST_USER.id}`);
  }
}

/**
 * Readies local Auth for a tour run.
 *
 * @returns The local keys a tour process needs.
 */
export async function prepareLocalSupabase(): Promise<LocalSupabaseKeys> {
  const keys = await readLocalSupabase();
  await ensureTestUser(keys.serviceRoleKey);
  return keys;
}

/** CLI entry. */
async function main(command: string | undefined): Promise<void> {
  if (command === "start") {
    if (!supabaseCli(["start"], false).ok) process.exit(1);
    await prepareLocalSupabase();
    console.error(`local Supabase: Auth on ${TOUR_SUPABASE_URL}, tour test user ${TOUR_TEST_USER.email} ready`);
    return;
  }
  if (command === "stop") {
    process.exit(supabaseCli(["stop"], false).ok ? 0 : 1);
  }
  if (command === "prepare") {
    const { anonKey, serviceRoleKey } = await prepareLocalSupabase();
    // stdout carries exactly this line; everything else goes to stderr. The
    // runner assigns it onto its env before provisioning and before
    // Playwright, and the tour config re-derives the same set from
    // TOUR_SUPABASE_ANON_KEY after its `.env` load.
    process.stdout.write(
      `${JSON.stringify({
        TOUR_SUPABASE_ANON_KEY: anonKey,
        TOUR_SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
        ...tourAuthEnv({ anonKey, serviceRoleKey }),
      })}\n`,
    );
    return;
  }
  console.error("usage: tsx local-supabase.ts start | stop | prepare");
  process.exit(2);
}

if (process.argv[1]?.endsWith("local-supabase.ts")) {
  main(process.argv[2]).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
