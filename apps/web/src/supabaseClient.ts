/**
 * Lazy Supabase client from `VITE_SUPABASE_*` env vars; returns null when unset.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null | undefined;

/**
 * Clears or replaces the cached Supabase client singleton.
 * @param next - Replacement client, explicit `null` when env vars are missing, or `undefined` to clear and lazily rebuild on the next {@link getSupabaseClient} call.
 * @returns Nothing; mutates the module-level cache only.
 */
export function resetSupabaseClientCache(next: SupabaseClient | null | undefined = undefined) {
  cached = next;
}

/**
 * Returns the singleton Supabase client for MVP auth hydration.
 * @returns Cached `SupabaseClient` when `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set; otherwise `null`.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (cached !== undefined) {
    return cached;
  }
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    cached = null;
    return cached;
  }
  const inTest = import.meta.env.MODE === "test";
  cached = createClient(url, key, {
    auth: {
      persistSession: !inTest,
      autoRefreshToken: !inTest,
      detectSessionInUrl: false,
    },
  });
  return cached;
}
