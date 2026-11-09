/**
 * Test design (testing-strategy)
 *
 * Setup: createOmieAdapter(env) / resolveOmieAccess(env). HTTP path is not
 * exercised — credentials must not call fetch in the unset cases.
 *
 * Oracle: omie-mock — Mock selection is explicit and never silently replaces
 * the real ERP. Credentials win over the mock opt-in.
 *
 * Axes
 *   A1 OMIE_APP_KEY / SECRET — unset / set
 *   A2 OMIE_MOCK — unset / "1"
 *
 * Outputs: O1 empty fake; O2 HTTP (no putCount); O3 mock (seeded linked client);
 *   O4 access kind credentials / mock / inactive
 *
 * Sampled-cell
 *   neither                         | A1 unset A2 unset | O1 O4 inactive | HTTP
 *   key blank                       | A1 empty          | O1 | HTTP
 *   both credentials                | A1 set            | O2 O4 cred     | putCount
 *   credentials + OMIE_MOCK=1       | A1 set A2 1       | O2 O4 cred     | mock
 *   OMIE_MOCK=1 no credentials      | A1 unset A2 1     | O3 O4 mock     | HTTP / empty get
 *
 * Decision: credentials first, then mock opt-in, else inactive/empty fake.
 * Out of scope: live sockets (http.test.ts stubs fetch).
 */
import { describe, expect, it, vi } from "vitest";
import { createOmieAdapter, resolveOmieAccess } from "./create-adapter.js";

describe("createOmieAdapter", () => {
  it("returns the fake when credentials are unset and never fetches", async () => {
    const fetchSpy = vi.fn();
    const previous = globalThis.fetch;
    globalThis.fetch = fetchSpy as typeof fetch;

    const adapter = createOmieAdapter({});
    await adapter.get("1");

    expect("putCount" in adapter).toBe(true);
    expect(await adapter.get("omie-mock-linked")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    globalThis.fetch = previous;
  });

  it("returns the fake when the key is blank", async () => {
    const adapter = createOmieAdapter({ OMIE_APP_KEY: "   ", OMIE_APP_SECRET: "secret" });
    expect("putCount" in adapter).toBe(true);
  });

  it("returns the HTTP adapter when both credentials are set", () => {
    const adapter = createOmieAdapter({ OMIE_APP_KEY: "k", OMIE_APP_SECRET: "s" });
    expect("putCount" in adapter).toBe(false);
    expect("listPage" in adapter).toBe(true);
  });

  it("ignores OMIE_MOCK and OMIE_MOCK_DATASET when credentials are configured", () => {
    const adapter = createOmieAdapter({
      OMIE_APP_KEY: "k",
      OMIE_APP_SECRET: "s",
      OMIE_MOCK: "1",
      OMIE_MOCK_DATASET: "tidsci",
    });
    expect("putCount" in adapter).toBe(false);
    expect(
      resolveOmieAccess({
        OMIE_APP_KEY: "k",
        OMIE_APP_SECRET: "s",
        OMIE_MOCK: "1",
        OMIE_MOCK_DATASET: "tidsci",
      }),
    ).toBe("credentials");
  });

  it("returns the seeded mock client port when OMIE_MOCK=1 and credentials are absent", async () => {
    const fetchSpy = vi.fn();
    const previous = globalThis.fetch;
    globalThis.fetch = fetchSpy as typeof fetch;

    const adapter = createOmieAdapter({ OMIE_MOCK: "1" });
    const linked = await adapter.get("omie-mock-linked");

    expect("putCount" in adapter).toBe(true);
    expect(linked?.razao_social).toBe("Maria Linked");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(resolveOmieAccess({ OMIE_MOCK: "1" })).toBe("mock");
    expect(resolveOmieAccess({})).toBe("inactive");
    globalThis.fetch = previous;
  });
});
