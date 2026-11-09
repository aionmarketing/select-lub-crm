/**
 * Oracle: openspec/changes/close-stated-coverage-gaps/specs/repo-foundation/spec.md,
 * requirement "No tour reaches an off-box provider host" — scenarios "A complete
 * fixture still reaches no off-box host" and "The guard fails while the
 * redirection is unwired". Expected values come from that text, not from a run.
 *
 * WHY THIS LEVEL. The requirement wants the evidence server-side: on the API
 * process or the provider client's call path, compared against the exported
 * default-host constants — never the browser request listener, which cannot see
 * a call the server makes. So each case applies the env a tour API is spawned
 * with (`tourProviderEnv()`, the same function `tours-config.shared.ts` spreads
 * into the API's `webServer.env`), drives the REAL Motul and Tecfil client with
 * `fetch` captured, and reads the URL the client actually built. Nothing leaves
 * the process: the stub answers every call.
 *
 * POSITIVE AND NEGATIVE BOTH (design decision 5). "Not the default host" alone
 * would pass for a client that built no URL at all, so each case also requires
 * that a request WAS made and that its host is a loopback.
 *
 * SEEN RED (task 5.3). With `MOTUL_BASE_URL` / `TECFIL_BASE_URL` removed from
 * `tourProviderRedirects`, both provider cases fail and name the provider whose
 * compiled-in host would be reached. Recorded in the change's tasks.md.
 *
 * Out of scope: whether the quote path calls these clients at all (since
 * background-oil-research it does not — `conversas-oil-quote.tour.spec.ts`
 * walks that), and the plate/Omie adapters, which the mock opt-ins and blanked
 * credentials asserted at the bottom cover.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clients } from "@select-lub/core";
import { LOOPBACK_HOSTS } from "@select-lub/core/db";
import { blankedProviderCredentials, tourProviderEnv } from "../tour-provider-env.js";

const { motul, tecfil } = clients;

/** The env names the tour env sets, so each case can restore what was there. */
const TOUR_ENV = tourProviderEnv();
const saved: Record<string, string | undefined> = {};

/** URLs the clients asked `fetch` for during one case. */
let requested: URL[] = [];

beforeEach(() => {
  for (const [name, value] of Object.entries(TOUR_ENV)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  requested = [];
  motul.resetMotulBreaker();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      requested.push(new URL(input instanceof Request ? input.url : String(input)));
      // A 404 is non-retryable for both clients, so each call makes exactly one
      // request and fails fast — the URL is all this test reads.
      return new Response("not found", { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** Loopback hosts as `URL.hostname` spells them (IPv6 keeps its brackets). */
const loopbackHostnames = LOOPBACK_HOSTS.map((host) => (host.includes(":") ? `[${host}]` : host));

const providers = [
  {
    name: "Motul",
    defaultBaseUrl: motul.MOTUL_DEFAULT_BASE_URL,
    call: () => motul.getVehicleBrands("1"),
  },
  {
    name: "Tecfil",
    defaultBaseUrl: tecfil.TECFIL_DEFAULT_BASE_URL,
    call: () => tecfil.tecfilGet("consulta", {}),
  },
];

describe("a tour API's provider env", () => {
  it.each(providers)("sends $name to a loopback, never its compiled-in host", async ({ name, defaultBaseUrl, call }) => {
    await call().catch(() => undefined);

    // Positive side: the client did build and send a request.
    expect(requested, `${name} client made no request — nothing was observed`).toHaveLength(1);
    const [url] = requested;
    const defaultHost = new URL(defaultBaseUrl).host;
    // Negative side, named so a red run says which provider would be reached.
    expect(url!.host, `${name} would reach its production host ${defaultHost}`).not.toBe(defaultHost);
    expect(loopbackHostnames, `${name} request went to ${url!.host}, not a loopback`).toContain(url!.hostname);
  });

  it("blanks every provider credential and opts into the Omie and plate mocks", () => {
    for (const name of Object.keys(blankedProviderCredentials)) {
      expect(TOUR_ENV[name], name).toBe("");
    }
    expect(TOUR_ENV.OMIE_MOCK).toBe("1");
    expect(TOUR_ENV.PLACAS_MOCK).toBe("1");
  });
});
