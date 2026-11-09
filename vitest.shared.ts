import { defineConfig } from "vitest/config";

/** Defaults every package config should merge. Coverage lives on the root config. */
export const sharedVitestConfig = defineConfig({
  test: {
    // Live Prisma tests contend on one local Postgres when the workspace runs
    // projects in parallel; 10s is below that cost. Infinite loops still die.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
