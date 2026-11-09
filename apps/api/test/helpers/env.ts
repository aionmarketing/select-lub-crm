/**
 * Vitest setup: loads repo `.env` and points `DATABASE_URL` at `DATABASE_URL_TEST` when set.
 *
 * Import this module from Vitest config or test setup so integration tests use the test database
 * without mutating the developer's primary `DATABASE_URL` when `DATABASE_URL_TEST` is absent.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(import.meta.dirname, "../../../../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}
