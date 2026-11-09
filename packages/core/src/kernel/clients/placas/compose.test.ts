/**
 * Test design (testing-strategy)
 *
 * Setup: composePlateProviders over two fake PlateProviders with call counters.
 *
 * Spec: fallback runs only when the primary does not answer; both failing is
 * failed not not_found.
 *
 * Axes
 * A1 primary — found / not_found / failed / timeout-as-failed
 * A2 fallback — found / not_found / failed / not called
 *
 * Outputs: O-found (no fallback); O-found from fallback; O-not_found both;
 *   O-failed both
 *
 * Decision map (compose.ts)
 * D1 primary found           T: no-fallback it; F: fallthrough its
 * D2 fallback found          T: uses-fallback it; F: miss/fail its
 * D3 both not_found          T: composed-miss it; F: mixed fail it
 * D4 unconfigured hop        T: primary-miss + absent fallback it
 */
import { describe, expect, it } from "vitest";
import { composePlateProviders } from "./compose.js";
import { failedLookup, foundOrNotFound, type LookupResult, type PlateProvider } from "./port.js";

function fake(name: string, impl: (plate: string) => LookupResult): PlateProvider & { calls: number } {
  const provider: PlateProvider & { calls: number } = {
    name,
    calls: 0,
    async lookup(plate) {
      provider.calls += 1;
      return impl(plate);
    },
  };
  return provider;
}

const found = foundOrNotFound(
  { make: "VW" },
  { source: "provider", provider: "primary", billed: true },
);
const miss = foundOrNotFound({}, { source: "provider", provider: "primary", billed: true });
const fallbackFound = foundOrNotFound(
  { make: "HONDA" },
  { source: "provider", provider: "fallback", billed: true },
);

describe("composePlateProviders", () => {
  it("does not call the fallback when the primary returns fields", async () => {
    const primary = fake("primary", () => found);
    const fallback = fake("fallback", () => fallbackFound);
    const composed = composePlateProviders(primary, fallback);

    const result = await composed.lookup("ABC1D23");

    expect(result).toMatchObject({ status: "found", fields: { make: "VW" } });
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(0);
  });

  it("calls the fallback when the primary returns no usable field", async () => {
    const primary = fake("primary", () => miss);
    const fallback = fake("fallback", () => fallbackFound);
    const composed = composePlateProviders(primary, fallback);

    const result = await composed.lookup("ABC1D23");

    expect(result).toMatchObject({
      status: "found",
      fields: { make: "HONDA" },
      billedCalls: [
        { provider: "primary", outcome: "not_found" },
        { provider: "fallback", outcome: "found" },
      ],
    });
    expect(fallback.calls).toBe(1);
  });

  it("calls the fallback when the primary times out", async () => {
    const primary = fake("primary", () => failedLookup("primary", "provider_error"));
    const fallback = fake("fallback", () => fallbackFound);
    const composed = composePlateProviders(primary, fallback);

    expect(await composed.lookup("ABC1D23")).toMatchObject({
      status: "found",
      fields: { make: "HONDA" },
    });
    expect(fallback.calls).toBe(1);
  });

  it("yields failed rather than not_found when both providers error", async () => {
    const primary = fake("primary", () => failedLookup("primary", "provider_error"));
    const fallback = fake("fallback", () => failedLookup("fallback", "provider_error"));
    const composed = composePlateProviders(primary, fallback);

    const result = await composed.lookup("ABC1D23");

    expect(result).toMatchObject({
      status: "failed",
      reason: "provider_error",
      billed: false,
    });
    expect(result).not.toHaveProperty("fields");
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
  });

  it("yields not_found when both providers miss", async () => {
    const primary = fake("primary", () => miss);
    const fallback = fake("fallback", () =>
      foundOrNotFound({}, { source: "provider", provider: "fallback", billed: true }),
    );
    const composed = composePlateProviders(primary, fallback);

    expect(await composed.lookup("ABC1D23")).toMatchObject({
      status: "not_found",
      billedCalls: [
        { provider: "primary", outcome: "not_found" },
        { provider: "fallback", outcome: "not_found" },
      ],
    });
  });
});
