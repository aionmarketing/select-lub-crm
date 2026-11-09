/**
 * Singleton Prisma client for CRM Postgres. Instantiated only when `DATABASE_URL` is set.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const envPath = resolve(import.meta.dirname, "../../../../../.env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

/**
 * Shared Prisma client for API and worker processes.
 *
 * Loads the repository root's `.env` (`../../../../../.env` from this file) when `DATABASE_URL` is unset and that file exists.
 *
 * @returns Live `PrismaClient` when `DATABASE_URL` is set after optional env load; `null` so callers can fall back to in-memory stores.
 */
export const prisma: PrismaClient | null = process.env.DATABASE_URL
  ? new PrismaClient()
  : null;
