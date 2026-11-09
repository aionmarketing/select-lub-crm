/**
 * Test design (testing-strategy)
 *
 * SUT: `isTransientConnectionFailure` / `seedWithConnectionRetry` — pure
 *   control flow over an injected seed function and an injected sleep. No
 *   Postgres, no Playwright, no timers.
 *
 * Oracle: the measured shape of the failure. `seedE2eFixtures` intermittently
 *   dies on `PrismaClientInitializationError: Can't reach database server at
 *   127.0.0.1:5433`, 14 times across 9 runs, and every single occurrence landed
 *   in test #2 or test #4 of the 30-test suite — never once in tests 5..30.
 *   Postgres itself logged no refusal, no termination and no "too many
 *   connections" in the whole window, and was up and healthy throughout, so the
 *   connection never reached it: Docker Desktop's loopback forwarder drops it
 *   while three dev servers boot. The signal to wait on is therefore Postgres
 *   actually accepting the connection.
 *
 * Out of scope: whether the seed's WRITES are correct (seed-e2e's own concern),
 *   and the loopback forwarder itself, which is not ours to fix.
 */
import { describe, expect, it, vi } from "vitest";
import { isTransientConnectionFailure, seedWithConnectionRetry } from "./seed-retry.js";

/** Builds the error Prisma actually throws for an unreachable server. */
function unreachable() {
  const error = new Error("\nInvalid `prisma.unit.findFirst()` invocation:\n\nCan't reach database server at `127.0.0.1:5433`");
  error.name = "PrismaClientInitializationError";
  return error;
}

describe("recognising a dropped connection", () => {
  it("treats Prisma's initialization error as transient", () => {
    expect(isTransientConnectionFailure(unreachable())).toBe(true);
  });

  it("does NOT treat a unique-constraint failure as transient", () => {
    // The point of the narrow test: retrying a DATA error would re-run a seed
    // that already half-applied, and would hide a real defect behind a retry.
    const error = new Error("Unique constraint failed on the fields: (`id`)");
    error.name = "PrismaClientKnownRequestError";
    expect(isTransientConnectionFailure(error)).toBe(false);
  });

  it("does not treat an arbitrary error as transient", () => {
    expect(isTransientConnectionFailure(new Error("boom"))).toBe(false);
  });
});

describe("seeding across a dropped connection", () => {
  it("retries a dropped connection and succeeds", async () => {
    const seed = vi.fn().mockRejectedValueOnce(unreachable()).mockResolvedValueOnce(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await seedWithConnectionRetry(seed, { attempts: 4, sleep });

    expect(seed).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("rethrows a data error on the FIRST failure, without retrying", async () => {
    const error = new Error("Unique constraint failed");
    error.name = "PrismaClientKnownRequestError";
    const seed = vi.fn().mockRejectedValue(error);

    await expect(
      seedWithConnectionRetry(seed, { attempts: 4, sleep: vi.fn().mockResolvedValue(undefined) }),
    ).rejects.toThrow("Unique constraint failed");
    expect(seed).toHaveBeenCalledTimes(1);
  });

  it("gives up and rethrows when the server is genuinely unreachable", async () => {
    // Bounded, so a real outage still fails the suite rather than hanging it.
    const seed = vi.fn().mockRejectedValue(unreachable());

    await expect(
      seedWithConnectionRetry(seed, { attempts: 3, sleep: vi.fn().mockResolvedValue(undefined) }),
    ).rejects.toThrow("Can't reach database server");
    expect(seed).toHaveBeenCalledTimes(3);
  });
});
