/**
 * Test design (testing-strategy)
 *
 * Setup: resolveWorkerHost(env) with a fresh env object. Does not
 * rewrite process.env (parallel tests keep WORKER_HOST from the shell).
 *
 * Spec rule (deploy: worker bind host): local default is loopback;
 * Fly sets WORKER_HOST=0.0.0.0 so the proxy can reach the process.
 *
 * Axes
 *   A1 WORKER_HOST — unset / 0.0.0.0 / empty string
 *
 * Outputs
 *   O1 "127.0.0.1"; O2 "0.0.0.0"; O3 "" (?? keeps empty; not nullish)
 *
 * Sampled-cell
 *   unset        | A1 unset | O1 | 0.0.0.0
 *   0.0.0.0      | A1 set   | O2 | loopback
 *   empty string | A1 empty | O3 | loopback (would mean || not ??)
 *
 * Decision map
 *   D1 env.WORKER_HOST nullish T: unset it; F: 0.0.0.0 + empty
 *
 * Out of scope: Fastify listen(); docker logs (task 2.2).
 */
import { describe, expect, it } from "vitest";
import { resolveWorkerHost } from "./bind-host.js";

describe("resolveWorkerHost", () => {
  it("defaults to loopback when WORKER_HOST is unset", () => {
    expect(resolveWorkerHost({})).toBe("127.0.0.1");
  });

  it("uses WORKER_HOST when it is set to all interfaces", () => {
    expect(resolveWorkerHost({ WORKER_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });

  it("keeps an empty WORKER_HOST because the fallback is nullish-only", () => {
    expect(resolveWorkerHost({ WORKER_HOST: "" })).toBe("");
  });
});
