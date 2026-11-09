/**
 * Vitest setup for `@select-lub/core`: installs the network backstop and fails any test that tried
 * to reach a non-loopback host, even when the code under test swallowed the error
 * (`network-guard.ts`).
 */
import { afterEach } from "vitest";
import { installNetworkGuard, takeNetworkViolations } from "./network-guard.js";

installNetworkGuard();

afterEach(() => {
  const refused = takeNetworkViolations();
  if (refused.length > 0) {
    throw new Error(`test network guard: this test tried to reach ${refused.map((v) => `${v.host}:${v.port ?? "?"}`).join(", ")}; tests must use fakes`);
  }
});
