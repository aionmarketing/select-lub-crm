/**
 * Supabase password grant shared by the local and remote Playwright suites.
 *
 * Its own module, not part of `fixtures.ts`, because `fixtures.ts` imports
 * `seed-e2e.ts` -> `@select-lub/core/db`. The remote suite must reach no database at
 * all (deploy — "Remote smoke writes nothing"), so it needs the token without
 * dragging Prisma and the fixture seed in behind it.
 */

/**
 * Password-grant against Supabase Auth using the same env as SPA auto-login.
 * @returns Access token for `Authorization: Bearer` on the CRM API.
 */
export async function supabaseAccessToken() {
  const url = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anon = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
  const email = process.env.VITE_MVP_LOGIN_EMAIL;
  const password = process.env.VITE_MVP_LOGIN_PASSWORD;
  if (!url || !anon || !email || !password) {
    throw new Error(
      "Playwright auto-login needs VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_MVP_LOGIN_EMAIL, and VITE_MVP_LOGIN_PASSWORD",
    );
  }
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: anon,
      Authorization: `Bearer ${anon}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    throw new Error(`Playwright Supabase login failed (${response.status})`);
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error("Playwright Supabase login returned no access_token");
  }
  return body.access_token;
}
